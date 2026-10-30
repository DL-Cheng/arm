/*
  智慧機器手臂 (5 指 + 手腕，共 6 顆 MG996R)
  ESP32 + WiFi + MQTT (broker.emqx.io)  ——  搭配手機網頁 App 控制

  需要安裝的函式庫 (Arduino IDE → 函式庫管理員)：
    1. ESP32Servo   (Kevin Harrington / John K. Bennett)
    2. PubSubClient (Nick O'Leary)
    3. ArduinoJson  (Benoit Blanchon，v7.x)
  開發板：ESP32 Dev Module

  接線 (MG996R 三條線：橘/黃=訊號、紅=V+、棕/黑=GND)：
    拇指  GPIO25     食指  GPIO26     中指  GPIO27
    無名指 GPIO32    小指  GPIO33     手腕  GPIO13
    ※ 6 顆伺服馬達的紅線接「外部 5～6V 電源」(建議 6V、5A 以上)，
      嚴禁由 ESP32 的 5V / USB 供電。
    ※ 外部電源 GND 必須與 ESP32 GND 共地。
    ※ 電源端並聯 1000～2200 uF 電解電容，可減少抖動與重置。

  MQTT 主題 (BASE = shutech/robotarm/<DEVICE_ID>)：
    BASE/cmd     (App → ESP32) 控制指令，JSON
    BASE/status  (ESP32 → App) 狀態回報，JSON
    BASE/online  (ESP32 → App) "1"=在線 / "0"=離線 (retained + LWT)

  指令格式 (cmd)：
    {"s":[拇,食,中,無名,小,腕]}   手動設定 6 軸，0~100 (手指 0=伸直 100=彎曲；手腕 50=置中)
    {"i":1,"v":80}                單軸設定
    {"mode":"manual"}             停止示範，維持目前姿勢
    {"mode":"demo","demo":"wave"} 啟動示範：wave / count / rps / grab / show
    {"mode":"relax"}              放鬆 (停止 PWM，馬達不出力)
    {"speed":200}                 手動動作速度 (%/秒，20~600)
*/

#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <ESP32Servo.h>

// ======================= 使用者設定 =======================
const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASS = "YOUR_WIFI_PASSWORD";

const char*    MQTT_HOST = "broker.emqx.io";
const uint16_t MQTT_PORT = 1883;
// 公用 broker 任何人都能訂閱，請改成自己獨一無二的 ID，並與網頁設定相同
const char*    DEVICE_ID = "DL-RobotArm";

// 每軸設定：名稱、腳位、「伸直/0%」角度、「彎曲/100%」角度
// 若方向相反，把 openDeg 與 bendDeg 對調即可 (例如 180 與 0)。
// 若馬達頂到機構極限，縮小角度範圍 (例如 20 與 160)。
struct ServoCfg {
  const char* name;
  uint8_t pin;
  int openDeg;
  int bendDeg;
};
ServoCfg CFG[6] = {
  {"thumb",  25, 0,   180},
  {"index",  26, 0,   180},
  {"middle", 27, 0,   180},
  {"ring",   32, 0,   180},
  {"little", 33, 0,   180},
  {"wrist",  13, 0,   180},   // 50% = 90 度置中
};
const int PULSE_MIN_US = 500;    // MG996R 500~2500 us
const int PULSE_MAX_US = 2500;
// ==========================================================

#define N 6

// ---------- 示範動作 ----------
struct Step {
  int16_t  p[N];     // 目標位置 0~100
  uint16_t speed;    // 移動速度 (%/秒)
  uint16_t hold;     // 到位後停留 (ms)
};

// 拇 食 中 無 小 腕
const Step DEMO_WAVE[] = {
  {{0,0,0,0,0,50},       400, 300},
  {{100,0,0,0,0,50},     500, 0},
  {{100,100,0,0,0,50},   500, 0},
  {{100,100,100,0,0,50}, 500, 0},
  {{100,100,100,100,0,50}, 500, 0},
  {{100,100,100,100,100,50}, 500, 200},
  {{100,100,100,100,0,50},  500, 0},
  {{100,100,100,0,0,50},    500, 0},
  {{100,100,0,0,0,50},      500, 0},
  {{100,0,0,0,0,50},        500, 0},
  {{0,0,0,0,0,50},          500, 300},
  {{0,0,0,0,100,50},        500, 0},
  {{0,0,0,100,100,50},      500, 0},
  {{0,0,100,100,100,50},    500, 0},
  {{0,100,100,100,100,50},  500, 0},
  {{100,100,100,100,100,50},500, 200},
  {{0,0,0,0,0,50},          400, 600},
};

const Step DEMO_COUNT[] = {
  {{100,100,100,100,100,50}, 300, 500},   // 握拳
  {{100,0,100,100,100,50},   300, 800},   // 1
  {{100,0,0,100,100,50},     300, 800},   // 2
  {{100,0,0,0,100,50},       300, 800},   // 3
  {{100,0,0,0,0,50},         300, 800},   // 4
  {{0,0,0,0,0,50},           300, 1000},  // 5
  {{100,100,100,100,100,50}, 300, 400},
};

const Step DEMO_RPS[] = {
  {{0,0,0,0,0,50},           300, 400},
  {{100,100,100,100,100,50}, 500, 900},   // 石頭
  {{0,0,0,0,0,50},           500, 900},   // 布
  {{100,0,0,100,100,50},     500, 900},   // 剪刀
  {{100,100,100,100,100,50}, 500, 900},   // 石頭
  {{0,0,0,0,0,50},           500, 600},
};

const Step DEMO_GRAB[] = {
  {{0,0,0,0,0,50},           300, 400},   // 張開
  {{0,0,0,0,0,20},           150, 300},   // 手腕左轉，對準物體
  {{60,60,60,60,60,20},      120, 1000},  // 抓取
  {{60,60,60,60,60,80},      100, 600},   // 手腕右轉搬運
  {{60,60,60,60,60,50},      100, 400},   // 回正
  {{0,0,0,0,0,50},           250, 800},   // 放開
  {{0,0,0,0,0,0},            100, 200},   // 手腕掃描
  {{0,0,0,0,0,100},          100, 200},
  {{0,0,0,0,0,50},           150, 500},
};

struct Demo {
  const char* id;
  const Step* steps;
  uint8_t     len;
};
#define LEN(a) (sizeof(a) / sizeof(a[0]))
const Demo DEMOS[] = {
  {"wave",  DEMO_WAVE,  LEN(DEMO_WAVE)},
  {"count", DEMO_COUNT, LEN(DEMO_COUNT)},
  {"rps",   DEMO_RPS,   LEN(DEMO_RPS)},
  {"grab",  DEMO_GRAB,  LEN(DEMO_GRAB)},
};
const uint8_t DEMO_N = sizeof(DEMOS) / sizeof(DEMOS[0]);
const int8_t  DEMO_SHOW = -2;      // 全部展示

// ---------- 全域狀態 ----------
enum Mode { MODE_MANUAL, MODE_DEMO, MODE_RELAX };

Servo   servos[N];
bool    attachedAll = false;
float   cur[N]    = {0, 0, 0, 0, 0, 50};
float   target[N] = {0, 0, 0, 0, 0, 50};
float   manualSpeed = 250;         // %/秒
float   moveSpeed   = 250;         // 目前使用的速度

Mode    mode = MODE_MANUAL;
int8_t  demoSel = -1;              // 選擇的示範 (0..DEMO_N-1 或 DEMO_SHOW)
uint8_t playing = 0;               // 實際播放中的示範
uint8_t stepIdx = 0;
bool    stepStarted = false;
bool    stepReached = false;
uint32_t reachedAt = 0;

WiFiClient   wifiClient;
PubSubClient mqtt(wifiClient);
String topicBase, topicCmd, topicStatus, topicOnline;

bool     statusDirty = true;
uint32_t lastPub = 0, lastTick = 0, lastMqttTry = 0, lastWifiTry = 0;
int      lastShown[N] = {-1, -1, -1, -1, -1, -1};

// ---------- 伺服馬達 ----------
int pctToUs(int i, float pct) {
  float deg = CFG[i].openDeg + (CFG[i].bendDeg - CFG[i].openDeg) * pct / 100.0f;
  deg = constrain(deg, 0.0f, 180.0f);
  return PULSE_MIN_US + (int)(deg * (PULSE_MAX_US - PULSE_MIN_US) / 180.0f);
}

void writeServo(int i) {
  servos[i].writeMicroseconds(pctToUs(i, cur[i]));
}

// 逐顆啟動，避免 6 顆同時啟動造成突波電流
void attachAll() {
  if (attachedAll) return;
  for (int i = 0; i < N; i++) {
    servos[i].setPeriodHertz(50);
    servos[i].attach(CFG[i].pin, PULSE_MIN_US, PULSE_MAX_US);
    writeServo(i);
    delay(120);
  }
  attachedAll = true;
}

void detachAll() {
  for (int i = 0; i < N; i++) servos[i].detach();
  attachedAll = false;
}

void setTarget(int i, float v) {
  if (i < 0 || i >= N) return;
  target[i] = constrain(v, 0.0f, 100.0f);
}

bool allReached() {
  for (int i = 0; i < N; i++) if (fabsf(cur[i] - target[i]) > 0.5f) return false;
  return true;
}

// 每 10 ms 往目標靠近一小步，達成平滑運動
void servoTick() {
  uint32_t now = millis();
  if (now - lastTick < 10) return;
  float dt = (now - lastTick) / 1000.0f;
  lastTick = now;
  if (mode == MODE_RELAX || !attachedAll) return;

  float maxStep = moveSpeed * dt;
  for (int i = 0; i < N; i++) {
    float d = target[i] - cur[i];
    if (fabsf(d) < 0.01f) continue;
    if (fabsf(d) <= maxStep) cur[i] = target[i];
    else cur[i] += (d > 0 ? maxStep : -maxStep);
    writeServo(i);
  }
}

// ---------- 示範引擎 ----------
void startDemo(int8_t sel) {
  attachAll();
  demoSel = sel;
  playing = (sel == DEMO_SHOW) ? 0 : sel;
  stepIdx = 0;
  stepStarted = stepReached = false;
  mode = MODE_DEMO;
  statusDirty = true;
}

void stopDemo() {
  if (mode == MODE_DEMO) {
    // 停在目前位置
    for (int i = 0; i < N; i++) target[i] = cur[i];
  }
  mode = MODE_MANUAL;
  demoSel = -1;
  moveSpeed = manualSpeed;
  statusDirty = true;
}

void demoTick() {
  if (mode != MODE_DEMO) return;
  const Demo& d = DEMOS[playing];
  const Step& s = d.steps[stepIdx];
  uint32_t now = millis();

  if (!stepStarted) {
    for (int i = 0; i < N; i++) setTarget(i, s.p[i]);
    moveSpeed = s.speed;
    stepStarted = true;
    stepReached = false;
    statusDirty = true;
  } else if (!stepReached) {
    if (allReached()) { stepReached = true; reachedAt = now; }
  } else if (now - reachedAt >= s.hold) {
    stepIdx++;
    stepStarted = false;
    if (stepIdx >= d.len) {
      stepIdx = 0;
      if (demoSel == DEMO_SHOW) playing = (playing + 1) % DEMO_N;
    }
  }
}

// ---------- MQTT ----------
const char* modeName() {
  switch (mode) {
    case MODE_DEMO:  return "demo";
    case MODE_RELAX: return "relax";
    default:         return "manual";
  }
}

const char* demoName() {
  if (mode != MODE_DEMO) return "";
  if (demoSel == DEMO_SHOW) return "show";
  return DEMOS[demoSel].id;
}

void publishStatus() {
  JsonDocument doc;
  doc["mode"] = modeName();
  doc["demo"] = demoName();
  if (mode == MODE_DEMO) doc["now"] = DEMOS[playing].id;   // 全部展示時目前播放的動作
  doc["spd"]  = (int)manualSpeed;
  JsonArray a = doc["s"].to<JsonArray>();
  for (int i = 0; i < N; i++) {
    int v = (int)roundf(cur[i]);
    a.add(v);
    lastShown[i] = v;
  }
  doc["rssi"] = WiFi.RSSI();
  doc["up"]   = (uint32_t)(millis() / 1000);

  char buf[256];
  size_t n = serializeJson(doc, buf, sizeof(buf));
  mqtt.publish(topicStatus.c_str(), (const uint8_t*)buf, n, false);
  lastPub = millis();
  statusDirty = false;
}

void handleCommand(const char* payload, unsigned int len) {
  JsonDocument doc;
  if (deserializeJson(doc, payload, len)) return;

  // 速度
  if (doc["speed"].is<int>()) {
    manualSpeed = constrain((int)doc["speed"], 20, 600);
    if (mode != MODE_DEMO) moveSpeed = manualSpeed;
    statusDirty = true;
  }

  // 模式
  if (doc["mode"].is<const char*>()) {
    String m = doc["mode"].as<String>();
    if (m == "demo") {
      String id = doc["demo"] | "show";
      int8_t sel = DEMO_SHOW;
      for (uint8_t k = 0; k < DEMO_N; k++) if (id == DEMOS[k].id) sel = k;
      startDemo(sel);
    } else if (m == "manual") {
      stopDemo();
    } else if (m == "relax") {
      stopDemo();
      mode = MODE_RELAX;
      detachAll();
      statusDirty = true;
    }
    return;
  }

  // 手動位置指令：自動結束示範、喚醒馬達
  bool moved = false;
  if (doc["s"].is<JsonArray>()) {
    JsonArray a = doc["s"].as<JsonArray>();
    for (int i = 0; i < N && i < (int)a.size(); i++) setTarget(i, a[i].as<float>());
    moved = true;
  } else if (doc["i"].is<int>() && doc["v"].is<float>()) {
    setTarget(doc["i"].as<int>(), doc["v"].as<float>());
    moved = true;
  }
  if (moved) {
    if (mode == MODE_RELAX) {
      // 由放鬆狀態醒來：先在「上次位置」重新送出 PWM，再平滑移向新目標
      mode = MODE_MANUAL;
      attachAll();
    }
    if (mode == MODE_DEMO) stopDemo();
    moveSpeed = manualSpeed;
    statusDirty = true;
  }
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  handleCommand((const char*)payload, length);
}

void mqttEnsure() {
  if (mqtt.connected() || WiFi.status() != WL_CONNECTED) return;
  if (millis() - lastMqttTry < 4000) return;
  lastMqttTry = millis();

  String cid = String("robotarm-") + DEVICE_ID + "-" + String((uint32_t)ESP.getEfuseMac(), HEX);
  Serial.print("MQTT 連線中...");
  if (mqtt.connect(cid.c_str(), nullptr, nullptr, topicOnline.c_str(), 0, true, "0")) {
    Serial.println("成功");
    mqtt.publish(topicOnline.c_str(), "1", true);
    mqtt.subscribe(topicCmd.c_str());
    statusDirty = true;
  } else {
    Serial.printf("失敗 rc=%d\n", mqtt.state());
  }
}

void wifiEnsure() {
  if (WiFi.status() == WL_CONNECTED) return;
  if (millis() - lastWifiTry < 10000) return;
  lastWifiTry = millis();
  Serial.println("WiFi 重新連線...");
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASS);
}

// ---------- Arduino ----------
void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\n=== 智慧機器手臂 ===");

  ESP32PWM::allocateTimer(0);
  ESP32PWM::allocateTimer(1);
  ESP32PWM::allocateTimer(2);
  ESP32PWM::allocateTimer(3);
  attachAll();                    // 啟動後先回到「張開、手腕置中」

  topicBase   = String("shutech/robotarm/") + DEVICE_ID;
  topicCmd    = topicBase + "/cmd";
  topicStatus = topicBase + "/status";
  topicOnline = topicBase + "/online";
  Serial.println("Topic: " + topicBase);

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  lastWifiTry = millis();

  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setBufferSize(512);
  mqtt.setKeepAlive(20);
  mqtt.setCallback(mqttCallback);
}

void loop() {
  // 伺服運動不依賴網路，即使斷線示範仍可持續
  demoTick();
  servoTick();

  wifiEnsure();
  mqttEnsure();
  if (mqtt.connected()) {
    mqtt.loop();

    uint32_t now = millis();
    bool changed = false;
    for (int i = 0; i < N; i++)
      if ((int)roundf(cur[i]) != lastShown[i]) { changed = true; break; }

    if ((statusDirty || changed) && now - lastPub >= 150) publishStatus();
    else if (now - lastPub >= 3000) publishStatus();   // 心跳
  }
}
