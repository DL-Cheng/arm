# 智慧機器手臂（5 指 + 手腕）

使用 6 顆 MG996R 伺服馬達驅動五根手指與手腕，由 ESP32 經 WiFi 連線 `broker.emqx.io`（MQTT），搭配手機網頁 App（英文介面，可安裝成 Web App）進行：

- **自主示範**：手指波浪、數字 1～5、剪刀石頭布、抓取與轉腕、全部展示（循環）
- **手動控制**：6 軸滑桿、9 種快速手勢、動作速度調整、放鬆馬達
- **即時回報**：手形圖會依手臂實際位置同步動作

## 檔案結構

```
RobotArm/
├─ index.html / style.css / app.js   手機網頁 App
├─ mqtt.min.js                        MQTT.js 5.10.1（本機附帶，支援離線載入）
├─ manifest.json / sw.js              PWA 安裝與離線快取
├─ icons/                             App 圖示（手掌造型）
├─ robotarm_esp32/robotarm_esp32.ino  ESP32 程式（Arduino IDE）
└─ README.md
```

## 一、硬體接線

| 軸 | 馬達訊號腳 | 軸 | 馬達訊號腳 |
|---|---|---|---|
| 拇指 | GPIO25 | 無名指 | GPIO32 |
| 食指 | GPIO26 | 小指 | GPIO33 |
| 中指 | GPIO27 | 手腕 | GPIO13 |

MG996R 線色：橘／黃＝訊號、紅＝V+、棕／黑＝GND。

> **電源注意**
> - 6 顆 MG996R 的紅線請接 **外部 5～6 V 電源**（建議 6 V、5 A 以上；堵轉時單顆可達 2.5 A），**不可**由 ESP32 的 5V／USB 供電。
> - 外部電源 GND 必須與 ESP32 GND **共地**。
> - 電源端並聯 1000～2200 µF 電容，可避免動作時 ESP32 重置或馬達抖動。
> - 程式啟動時會逐顆啟動馬達以降低突波電流。

## 二、燒錄 ESP32

1. Arduino IDE 安裝 ESP32 開發板支援，開發板選 **ESP32 Dev Module**。
2. 函式庫管理員安裝：**ESP32Servo**、**PubSubClient**、**ArduinoJson（v7.x）**。
3. 開啟 `robotarm_esp32/robotarm_esp32.ino`，修改：
   - `WIFI_SSID`、`WIFI_PASS`
   - `DEVICE_ID`：公用 broker 任何人皆可訂閱，請改成獨一無二的名稱（只用英數字與 `-`、`_`）
4. 上傳後開啟序列埠監控（115200）可看到連線狀況。

### 校正方向與角度範圍

`CFG[]` 中每一軸有 `openDeg`（0 % 伸直時的角度）與 `bendDeg`（100 % 彎曲時的角度）：

- 手指彎曲方向相反 → 把兩個數字對調（例如 `180, 0`）。
- 馬達頂到機構極限 → 縮小範圍（例如 `20, 160`）。
- 手腕 50 % 為中心位置。

**建議先把手臂機構放鬆、拆除拉線再通電測試，確認方向與範圍後再裝上拉線。**

## 三、部署網頁到 GitHub Pages

1. 將 `index.html`、`style.css`、`app.js`、`mqtt.min.js`、`manifest.json`、`sw.js`、`icons/` 上傳到 GitHub 儲存庫（根目錄）。
2. Settings → Pages → Branch 選 `main`、資料夾 `/ (root)`。
3. 以手機開啟 `https://<帳號>.github.io/<儲存庫>/`：
   - Android Chrome：選單 →「安裝應用程式」，或點網頁內「Install App」。
   - iPhone Safari：分享 →「加入主畫面」。
4. 打開「Connection Settings」，確認 **裝置 ID 與 ESP32 的 `DEVICE_ID` 相同**，按「Save & Reconnect」。右上角「Cloud」與「Arm」兩個指示燈都變綠即可控制。

> 更新網站後若手機仍是舊版，請修改 `sw.js` 內的 `VERSION` 再上傳。

## 四、MQTT 通訊規格

`BASE = shutech/robotarm/<DEVICE_ID>`；ESP32 使用 `broker.emqx.io:1883`，網頁使用 `wss://broker.emqx.io:8084/mqtt`。

| Topic | 方向 | 內容 |
|---|---|---|
| `BASE/cmd` | App → ESP32 | JSON 控制指令 |
| `BASE/status` | ESP32 → App | JSON 狀態（位置變化時約每 150 ms，閒置時每 3 秒） |
| `BASE/online` | ESP32 → App | `1` 在線 / `0` 離線（retained + LWT） |

**控制指令（cmd）**

```json
{"s":[0,0,0,0,0,50]}              // 6 軸位置 0~100：拇、食、中、無名、小、腕
{"i":1,"v":80}                    // 單軸
{"mode":"demo","demo":"wave"}     // wave / count / rps / grab / show
{"mode":"manual"}                 // 停止示範，保持姿勢
{"mode":"relax"}                  // 停止 PWM，馬達放鬆
{"speed":250}                     // 手動速度 20~600（%/秒）
```

**狀態（status）**

```json
{"mode":"demo","demo":"show","now":"wave","spd":250,"s":[0,0,0,0,0,50],"rssi":-58,"up":1234}
```

## 五、自訂示範動作

在 `.ino` 的 `DEMO_*` 陣列中編輯，每一列為一個步驟：

```
{{拇,食,中,無名,小,腕}, 速度(%/秒), 到位後停留(ms)}
```

新增動作後，把它加入 `DEMOS[]`，並在 `app.js` 的 `DEMOS` 加上對應的 `id` 與英文名稱即可。

## 六、安全提醒

- 動作時請避免手指夾入機構；初次測試請降低速度。
- 長時間不使用請按「Relax Motors」，可減少發熱與抖動。
- ESP32 斷線時，示範動作仍會繼續；需要停止可斷電或回到網頁按「Stop Demo」。
