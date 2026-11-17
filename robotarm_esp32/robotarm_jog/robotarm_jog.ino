/*
  機器手臂簡易點動控制 (Jog) —— 連續旋轉版 MG996R × 6，按住轉動、放開停止
  ESP32 + WiFi + MQTT (broker.emqx.io)

  連續旋轉伺服馬達：訊號脈寬 = 轉速與方向，沒有角度。
    約 1500 us = 停止；小於 1500 往一個方向轉；大於 1500 往另一個方向轉；離 1500 越遠轉越快。

  安全設計：
    1. 開機後「所有馬達都不輸出訊號」，直到網頁按下某顆馬達的按鈕，該顆才會啟動。
    2. 放開 → 先送「停止脈寬」，再斷開訊號 (連續旋轉馬達若中立點沒校準，持續送 1500 會緩慢爬行，
       斷開訊號可確保完全不動)。
    3. 按住才轉：網頁按住時每 80 ms 重送指令；ESP32 超過 300 ms 沒收到就自動停止
       (放開、手機當機、斷網、切換 App 都會停)。MQTT 斷線時立即停止全部。
    4. 沒有位置回授，所以用「轉動時間」推算行程 (travel)，並可設定軟體行程上下限，
       避免把拉線 / 捲軸轉過頭而損壞機構 (預設關閉，請依機構設定)。

  需要的函式庫：ESP32Servo、PubSubClient     開發板：ESP32 Dev Module

  接線 (訊號腳)：拇指 25、食指 26、中指 27、無名指 32、小指 33、手腕 13
  馬達紅線接外部 5~6 V 電源 (≥5 A)，GND 與 ESP32 共地，禁止由 ESP32 供電。
  建議每條訊號線對 GND 各接一顆 10 kΩ 下拉電阻。

  校正中立點 (第一次必做)：
    連續旋轉版 MG996R 的外殼側面有一個微調孔 (可變電阻)。
    先拆掉拉線，按住某顆馬達讓它轉，再放開；若放開後仍緩慢轉動，
    請用小螺絲起子微調，或修改下方 STOP_US[]，直到完全靜止為止。

  MQTT 主題 (BASE = shutech/robotarm-jog/<DEVICE_ID>)：
    BASE/cmd     網頁 → ESP32，文字指令：
                   M,<馬達0~5>,<方向>   方向 1 / -1 = 兩個轉向，0 = 停止
                   V,<速度>             脈寬偏移 us (20~400)，越大越快
                   S                    停止全部 (緊急停止)；R 同 S
                   Z                    行程計數歸零
    BASE/status  ESP32 → 網頁，JSON：{"t":[行程x10 ...],"m":[轉向 ...],"v":速度}
    BASE/online  "1"=在線 / "0"=離線 (retained + LWT)
*/

#include <WiFi.h>
#include <PubSubClient.h>
#include <ESP32Servo.h>

// ======================= 使用者設定 =======================
const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASS = "YOUR_WIFI_PASSWORD";

const char*    MQTT_HOST = "broker.emqx.io";
const uint16_t MQTT_PORT = 1883;
const char*    DEVICE_ID = "DL-RobotArm";      // 公用 broker，請改成獨一無二的名稱

#define N 6
const uint8_t PIN[N]      = {25, 26, 27, 32, 33, 13};

// 各馬達「停止」脈寬 (us)，依實測校正
int STOP_US[N]            = {1500, 1500, 1500, 1500, 1500, 1500};
// 網頁「+」按鈕對應的實際轉向：1 或 -1 (轉向相反時改成 -1)
const int8_t DIR_SIGN[N]  = {1, 1, 1, 1, 1, 1};

int   jogOffsetUs = 160;             // 轉速：脈寬偏移量 (網頁可調)，160 約為中速
const int OFFSET_MIN = 20, OFFSET_MAX = 400;

// 行程單位：以「中速 (偏移 160 us) 轉 1 秒 = 1.0」為基準，轉速不同會等比換算。
// 行程上下限預設很大 (等於關閉)。請依機構實測後縮小，例如 -6.0 ~ +6.0。
const float TRAVEL_MIN[N] = {-999, -999, -999, -999, -999, -999};
const float TRAVEL_MAX[N] = { 999,  999,  999,  999,  999,  999};

const uint32_t FAILSAFE_MS   = 300;  // 超過這段時間沒收到「按住」指令就停止
const uint32_t STOP_HOLD_MS  = 150;  // 送出停止脈寬後，保持這麼久再斷開訊號
const uint32_t MAX_RUN_MS    = 8000; // 單次按住最長連續轉動時間 (保護機構)，到時間自動停止
const int PULSE_MIN_US = 500;
const int PULSE_MAX_US = 2500;
// ==========================================================

Servo    servos[N];
bool     attached[N]   = {false, false, false, false, false, false};
int8_t   dir[N]        = {0, 0, 0, 0, 0, 0};        // 目前轉向 (網頁座標)
uint32_t lastCmd[N]    = {0, 0, 0, 0, 0, 0};
uint32_t runStart[N]   = {0, 0, 0, 0, 0, 0};
uint32_t detachAt[N]   = {0, 0, 0, 0, 0, 0};
uint32_t lastTry[N]    = {0, 0, 0, 0, 0, 0};   // 最近一次收到「轉動」指令的時間
bool     locked[N]     = {false, false, false, false, false, false};  // 超過單次最長時間後鎖定，需放開才能再轉
float    travel[N]     = {0, 0, 0, 0, 0, 0};

WiFiClient   wifiClient;
PubSubClient mqtt(wifiClient);
String topicCmd, topicStatus, topicOnline;

uint32_t lastTick = 0, lastPub = 0, lastMqttTry = 0, lastWifiTry = 0;
bool     statusDirty = true;

int pulseFor(int i, int d) {
  int us = STOP_US[i] + d * DIR_SIGN[i] * jogOffsetUs;
  return constrain(us, PULSE_MIN_US, PULSE_MAX_US);
}

void startMotor(int i, int d) {
  if (!attached[i]) {
    servos[i].setPeriodHertz(50);
    servos[i].attach(PIN[i], PULSE_MIN_US, PULSE_MAX_US);
    attached[i] = true;
  }
  detachAt[i] = 0;
  if (dir[i] != d) runStart[i] = millis();
  dir[i] = d;
  lastCmd[i] = millis();
  servos[i].writeMicroseconds(pulseFor(i, d));
  statusDirty = true;
}

// 先送停止脈寬，稍後在 servoTick() 中斷開訊號
void stopMotor(int i) {
  if (dir[i] == 0) return;
  dir[i] = 0;
  if (attached[i]) {
    servos[i].writeMicroseconds(STOP_US[i]);
    detachAt[i] = millis() + STOP_HOLD_MS;
  }
  statusDirty = true;
}

void stopAll() {
  for (int i = 0; i < N; i++) stopMotor(i);
}

void servoTick() {
  uint32_t now = millis();
  if (now - lastTick < 10) return;
  float dt = (now - lastTick) / 1000.0f;
  if (dt > 0.1f) dt = 0.1f;          // 避免卡頓時行程被一次積分過大
  lastTick = now;

  for (int i = 0; i < N; i++) {
    if (dir[i] != 0) {
      // 失效保護 / 單次最長時間
      if (now - lastCmd[i] > FAILSAFE_MS) { stopMotor(i); continue; }
      if (now - runStart[i] > MAX_RUN_MS) { locked[i] = true; stopMotor(i); continue; }
      travel[i] += dir[i] * (jogOffsetUs / 160.0f) * dt;
      if ((dir[i] > 0 && travel[i] >= TRAVEL_MAX[i]) || (dir[i] < 0 && travel[i] <= TRAVEL_MIN[i])) {
        stopMotor(i);                         // 到達行程極限
      }
      statusDirty = true;
    } else if (attached[i] && detachAt[i] && now >= detachAt[i]) {
      servos[i].detach();
      attached[i] = false;
      detachAt[i] = 0;
    }
  }
}

void handleCommand(const char* payload, unsigned int len) {
  char buf[32];
  if (len == 0 || len >= sizeof(buf)) return;
  memcpy(buf, payload, len);
  buf[len] = 0;

  switch (buf[0]) {
    case 'M': {
      int i, d;
      if (sscanf(buf, "M,%d,%d", &i, &d) != 2 || i < 0 || i >= N) return;
      uint32_t now = millis();
      if (d == 0) { locked[i] = false; stopMotor(i); break; }
      d = d > 0 ? 1 : -1;
      if (now - lastTry[i] > FAILSAFE_MS) locked[i] = false;   // 已經放開過，解除鎖定
      lastTry[i] = now;
      if (locked[i]) break;                                    // 單次轉太久：放開後才能再轉
      // 已在極限位置，不允許繼續往同方向轉
      if ((d > 0 && travel[i] >= TRAVEL_MAX[i]) || (d < 0 && travel[i] <= TRAVEL_MIN[i])) { stopMotor(i); break; }
      startMotor(i, d);
      break;
    }
    case 'V': {
      int v;
      if (sscanf(buf, "V,%d", &v) == 1) {
        jogOffsetUs = constrain(v, OFFSET_MIN, OFFSET_MAX);
        for (int i = 0; i < N; i++)                // 轉動中的馬達立刻套用新速度
          if (dir[i] != 0) servos[i].writeMicroseconds(pulseFor(i, dir[i]));
        statusDirty = true;
      }
      break;
    }
    case 'S':
    case 'R': stopAll(); break;
    case 'Z':
      for (int i = 0; i < N; i++) travel[i] = 0;
      statusDirty = true;
      break;
  }
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  handleCommand((const char*)payload, length);
}

void publishStatus() {
  char buf[128];
  int n = snprintf(buf, sizeof(buf),
                   "{\"t\":[%d,%d,%d,%d,%d,%d],\"m\":[%d,%d,%d,%d,%d,%d],\"v\":%d}",
                   (int)roundf(travel[0] * 10), (int)roundf(travel[1] * 10), (int)roundf(travel[2] * 10),
                   (int)roundf(travel[3] * 10), (int)roundf(travel[4] * 10), (int)roundf(travel[5] * 10),
                   dir[0], dir[1], dir[2], dir[3], dir[4], dir[5], jogOffsetUs);
  mqtt.publish(topicStatus.c_str(), (const uint8_t*)buf, n, false);
  lastPub = millis();
  statusDirty = false;
}

void mqttEnsure() {
  if (mqtt.connected() || WiFi.status() != WL_CONNECTED) return;
  if (millis() - lastMqttTry < 4000) return;
  lastMqttTry = millis();
  String cid = String("robotjog-") + DEVICE_ID + "-" + String((uint32_t)ESP.getEfuseMac(), HEX);
  if (mqtt.connect(cid.c_str(), nullptr, nullptr, topicOnline.c_str(), 0, true, "0")) {
    mqtt.publish(topicOnline.c_str(), "1", true);
    mqtt.subscribe(topicCmd.c_str());
    statusDirty = true;
    Serial.println("MQTT connected");
  } else {
    Serial.printf("MQTT failed rc=%d\n", mqtt.state());
  }
}

void wifiEnsure() {
  if (WiFi.status() == WL_CONNECTED) return;
  if (millis() - lastWifiTry < 10000) return;
  lastWifiTry = millis();
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASS);
}

void setup() {
  Serial.begin(115200);
  delay(200);

  // 重要：這裡「不」attach 任何馬達，開機時所有馬達都沒有訊號
  ESP32PWM::allocateTimer(0);
  ESP32PWM::allocateTimer(1);
  ESP32PWM::allocateTimer(2);
  ESP32PWM::allocateTimer(3);
  for (int i = 0; i < N; i++) pinMode(PIN[i], INPUT_PULLDOWN);
  Serial.println("\n=== Robot arm jog control (continuous rotation): all motors OFF ===");

  String base = String("shutech/robotarm-jog/") + DEVICE_ID;
  topicCmd    = base + "/cmd";
  topicStatus = base + "/status";
  topicOnline = base + "/online";
  Serial.println("Topic: " + base);

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  lastWifiTry = millis();

  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setKeepAlive(15);
  mqtt.setCallback(mqttCallback);
}

void loop() {
  wifiEnsure();
  mqttEnsure();

  if (mqtt.connected()) {
    mqtt.loop();
    uint32_t now = millis();
    if ((statusDirty && now - lastPub >= 100) || now - lastPub >= 2000) publishStatus();
  } else {
    stopAll();                     // 斷線 → 立即停止
  }

  servoTick();
}
