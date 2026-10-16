/* つかプロ / UNO R4 WiFi + TB6612FNG + two DC motors
 * Install Arduino UNO R4 Boards, select Arduino UNO R4 WiFi.
 * WiFiS3 is included in that board package. See README.md.
 */
#include <WiFiS3.h>
#include <FspTimer.h>

// ===== EDIT THESE VALUES TO MATCH YOUR EXISTING WIRING =====
const char WIFI_SSID[] = "YOUR_WIFI_NAME";
const char WIFI_PASSWORD[] = "YOUR_WIFI_PASSWORD";
const char ROBOT_KEY[] = "tsukapro"; // Same key in website settings; use your own value.
const int PWMA = 2, AIN1 = 4, AIN2 = 3;
const int PWMB = 7, BIN1 = 5, BIN2 = 6;
const int STBY = -1; // User wiring: STBY tied to 5V.
const bool LEFT_REVERSED = false, RIGHT_REVERSED = false;
// A = left motor, B = right motor. Timer-driven software PWM supports D2/D7.
// =========================================================

WiFiServer server(80);
struct Step { char command; unsigned long duration; int speed; };
Step steps[32];
int stepCount = 0, stepIndex = 0;
bool running = false;
unsigned long stepStarted = 0, lastHeartbeat = 0;
const unsigned long HEARTBEAT_TIMEOUT = 1800;
const char* reason = "idle";
WiFiClient client;
bool receiving = false;
String requestBuffer;
unsigned long requestStarted = 0;
FspTimer pwmTimer;
volatile uint8_t dutyA = 0, dutyB = 0;
volatile uint32_t heartbeatTicks = 14401;
volatile bool pwmTimedOut = true;
void pwmInterrupt(timer_callback_args_t*) {
  static uint8_t phase = 0;
  phase = (phase + 1) & 31;
  if (heartbeatTicks < 14401) heartbeatTicks++;
  if (heartbeatTicks > 14400) pwmTimedOut = true;
  bool alive = !pwmTimedOut; // 8000 ticks/s: latched 1.8 second motor cutoff.
  digitalWrite(PWMA, alive && phase < dutyA ? HIGH : LOW);
  digitalWrite(PWMB, alive && phase < dutyB ? HIGH : LOW);
}
bool startPWM() {
  uint8_t type = GPT_TIMER;
  int8_t channel = FspTimer::get_available_timer(type);
  if (channel < 0) return false;
  return pwmTimer.begin(TIMER_MODE_PERIODIC, type, channel, 8000.0f, 50.0f, pwmInterrupt)
    && pwmTimer.setup_overflow_irq() && pwmTimer.open() && pwmTimer.start();
}
void setDuty(int pin, int value) {
  uint8_t duty = (abs(value) * 32 + 127) / 255;
  if (pin == PWMA) dutyA = duty; else dutyB = duty;
  if (!duty) digitalWrite(pin, LOW);
}

void motor(int pwm, int in1, int in2, int value, bool reversed) {
  if (reversed) value = -value;
  setDuty(pwm, 0);
  digitalWrite(in1, value > 0 ? HIGH : LOW);
  digitalWrite(in2, value < 0 ? HIGH : LOW);
  setDuty(pwm, value);
}
void stopMotors() {
  setDuty(PWMA, 0); setDuty(PWMB, 0);
  digitalWrite(AIN1, LOW); digitalWrite(AIN2, LOW);
  digitalWrite(BIN1, LOW); digitalWrite(BIN2, LOW);
  if (STBY >= 0) digitalWrite(STBY, LOW);
}
void stopRobot(const char* why) { stopMotors(); running = false; reason = why; }
void applyStep() {
  Step s = steps[stepIndex]; int left = 0, right = 0;
  if (s.command == 'F') left = right = s.speed;
  if (s.command == 'B') left = right = -s.speed;
  if (s.command == 'L') { left = -s.speed; right = s.speed; }
  if (s.command == 'R') { left = s.speed; right = -s.speed; }
  if (s.command == 'S') { stopRobot("stop_block"); return; }
  if (STBY >= 0) digitalWrite(STBY, HIGH);
  motor(PWMA, AIN1, AIN2, left, LEFT_REVERSED);
  motor(PWMB, BIN1, BIN2, right, RIGHT_REVERSED);
  stepStarted = millis();
}
void tick() {
  if (!running) return;
  if (pwmTimedOut || millis() - lastHeartbeat > HEARTBEAT_TIMEOUT) { stopRobot("connection_lost"); return; }
  if (millis() - stepStarted >= steps[stepIndex].duration) {
    stopMotors();
    stepIndex++;
    if (stepIndex >= stepCount) stopRobot("complete"); else applyStep();
  }
}
bool number(const String& s, long& value) {
  if (!s.length() || s.length() > 5) return false;
  value = 0;
  for (unsigned int i = 0; i < s.length(); i++) { if (s[i] < '0' || s[i] > '9') return false; value = value * 10 + s[i] - '0'; }
  return true;
}
bool parseProgram(const String& body) {
  Step parsed[32]; int count = 0, start = 0;
  if (!body.length() || body.endsWith(";")) return false;
  while (start < (int)body.length()) {
    if (count >= 32) return false;
    int end = body.indexOf(';', start); if (end < 0) end = body.length();
    String token = body.substring(start, end);
    int comma = token.indexOf(',', 2); long duration, speed;
    if (token.length() < 5 || token[1] != ',' || comma < 0 || String("FBLRS").indexOf(token[0]) < 0) return false;
    if (!number(token.substring(2, comma), duration) || !number(token.substring(comma + 1), speed)) return false;
    if (duration < 100 || duration > 3000 || speed < 0 || speed > 200) return false;
    parsed[count++] = {token[0], (unsigned long)duration, (int)speed}; start = end + 1;
  }
  for (int i = 0; i < count; i++) steps[i] = parsed[i];
  stepCount = count; return count > 0;
}
String headerValue(const String& headers, const String& name) {
  int start = headers.indexOf("\r\n") + 2;
  while (start > 1 && start < (int)headers.length()) {
    int end = headers.indexOf("\r\n", start); if (end < 0) end = headers.length();
    String line = headers.substring(start, end); int colon = line.indexOf(':');
    if (colon > 0) { String key = line.substring(0, colon); key.toLowerCase(); if (key == name) { String value = line.substring(colon + 1); value.trim(); return value; } }
    start = end + 2;
  }
  return "";
}
String statusJSON() {
  return String("{\"device\":\"tsukapro-r4\",\"running\":") + (running ? "true" : "false") + ",\"index\":" + stepIndex + ",\"count\":" + stepCount + ",\"reason\":\"" + reason + "\"}";
}
void reply(int code, const String& json) {
  client.print(String("HTTP/1.1 ") + code + (code == 200 ? " OK\r\n" : " Error\r\n"));
  client.print("Content-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type, X-Robot-Key\r\nAccess-Control-Allow-Private-Network: true\r\nAccess-Control-Max-Age: 600\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: ");
  client.print(json.length()); client.print("\r\n\r\n"); client.print(json);
  client.stop(); receiving = false; requestBuffer = "";
}
void handle(const String& headers, const String& body) {
  int first = headers.indexOf(' '), second = headers.indexOf(' ', first + 1);
  if (first < 0 || second < 0) { reply(400, "{\"error\":\"bad_request\"}"); return; }
  String method = headers.substring(0, first), path = headers.substring(first + 1, second);
  if (method == "OPTIONS") { reply(200, "{}"); return; }
  if (method != "POST") { reply(405, "{\"error\":\"post_required\"}"); return; }
  if (headerValue(headers, "x-robot-key") != ROBOT_KEY) { reply(403, "{\"error\":\"wrong_key\"}"); return; }
  if (path == "/status") { reply(200, statusJSON()); return; }
  if (path == "/stop") { stopRobot("user_stop"); reply(200, statusJSON()); return; }
  if (path == "/heartbeat") { if (running && !pwmTimedOut) { lastHeartbeat = millis(); heartbeatTicks = 0; } reply(200, statusJSON()); return; }
  if (path == "/run") {
    if (running) { reply(409, "{\"error\":\"already_running\"}"); return; }
    if (!parseProgram(body)) { reply(400, "{\"error\":\"invalid_program\"}"); return; }
    stepIndex = 0; running = true; reason = "running"; lastHeartbeat = millis(); heartbeatTicks = 0; pwmTimedOut = false; applyStep(); reply(200, statusJSON()); return;
  }
  reply(404, "{\"error\":\"not_found\"}");
}
void serviceHTTP() {
  if (!receiving) { WiFiClient next = server.available(); if (next) { client = next; receiving = true; requestStarted = millis(); requestBuffer = ""; } }
  if (!receiving) return;
  // Read a bounded amount per loop so motor timers and heartbeat checks keep running.
  int budget = 128;
  while (client.available() && budget-- > 0) { requestBuffer += (char)client.read(); if (requestBuffer.length() > 4096) { reply(413, "{\"error\":\"too_large\"}"); return; } }
  int split = requestBuffer.indexOf("\r\n\r\n");
  if (split >= 0) {
    String headers = requestBuffer.substring(0, split + 2), len = headerValue(headers, "content-length"); long length = 0;
    if (headerValue(headers, "transfer-encoding").length() || (len.length() && !number(len, length)) || length > 1024) { reply(400, "{\"error\":\"invalid_length\"}"); return; }
    if ((int)requestBuffer.length() >= split + 4 + length) { handle(headers, requestBuffer.substring(split + 4, split + 4 + length)); return; }
  }
  if (!client.connected() || millis() - requestStarted > 700) { client.stop(); receiving = false; requestBuffer = ""; }
}
void setup() {
  for (int pin : {PWMA, AIN1, AIN2, PWMB, BIN1, BIN2}) pinMode(pin, OUTPUT);
  if (STBY >= 0) pinMode(STBY, OUTPUT);
  stopMotors(); Serial.begin(115200); requestBuffer.reserve(4096);
  if (!startPWM()) { Serial.println("PWM timer unavailable. Motors stopped."); while (true) delay(1000); }
  if (WiFi.status() == WL_NO_MODULE) { Serial.println("WiFi module unavailable. Check board firmware."); while (true) delay(1000); }
  while (WiFi.status() != WL_CONNECTED) { Serial.println("Connecting to WiFi..."); WiFi.begin(WIFI_SSID, WIFI_PASSWORD); delay(3000); }
  server.begin(); Serial.print("Robot IP: "); Serial.println(WiFi.localIP());
}
void loop() {
  tick();
  if (WiFi.status() != WL_CONNECTED) { if (running) stopRobot("wifi_lost"); }
  serviceHTTP();
}
