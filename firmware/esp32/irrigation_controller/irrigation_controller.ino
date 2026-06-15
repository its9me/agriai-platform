#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>

// ====== WiFi ======
const char* WIFI_SSID = "Tenda_Wa";
const char* WIFI_PASSWORD = "2244668844";

// ====== HiveMQ Cloud MQTT ======
const char* MQTT_HOST = "573502d47ef641058068d00a9b5882c3.s1.eu.hivemq.cloud";
const int MQTT_PORT = 8883;
const char* MQTT_USER = "its9me";
const char* MQTT_PASSWORD = "its9meits9mE";

// ====== AgriAI platform ======
const int DEFAULT_LAND_ID = 2;
const char* DEVICE_UID = "esp32-land-2-demo-valve";
const char* PLATFORM_BASE_URL = "http://192.168.0.184:3001";
const char* PLATFORM_IOT_TOKEN = "";

// ====== Pins ======
const int RELAY_PIN = 27;
const bool RELAY_ACTIVE_HIGH = false; // This relay turns ON when IN is LOW, so OFF must drive IN HIGH.

// HW-030 soil moisture sensor and HW-038 water level sensor are analog modules.
const bool HAS_SOIL_MOISTURE_SENSOR = true;
const bool HAS_TANK_SENSOR = true;

const int SOIL_MOISTURE_PIN = 35;
const int TANK_LEVEL_PIN = 34;

// ====== Safety ======
const int MAX_DURATION_SECONDS = 7200;
const unsigned long TELEMETRY_INTERVAL_MS = 60000UL;
const unsigned long ACTIVE_TELEMETRY_INTERVAL_MS = 5000UL;
const unsigned long PROGRESS_ACK_INTERVAL_MS = 10000UL;
const unsigned long MQTT_RECONNECT_INTERVAL_MS = 5000UL;
const unsigned long WIFI_RECONNECT_INTERVAL_MS = 5000UL;
const unsigned long DEVICE_CONFIG_REFRESH_INTERVAL_MS = 300000UL;

const float TANK_CAPACITY_LITERS = 2000.0;
const float DEFAULT_FLOW_LITERS_PER_MINUTE = 10.0;

// Adjust these after reading Serial output with the sensors dry/wet.
const int SOIL_DRY_RAW = 4095;
const int SOIL_WET_RAW = 470;
const int TANK_EMPTY_RAW = 0;
const int TANK_FULL_RAW = 2200;

WiFiClientSecure secureClient;
WiFiClientSecure httpsClient;
PubSubClient mqtt(secureClient);
Preferences preferences;

unsigned long lastTelemetryAt = 0;
unsigned long lastMqttReconnectAt = 0;
unsigned long lastWifiReconnectAt = 0;
unsigned long lastDeviceConfigRefreshAt = 0;

bool valveRunning = false;
bool relayCommandedOn = false;
int activeLandId = DEFAULT_LAND_ID;
unsigned long valveStopAt = 0;
unsigned long valveStartedAt = 0;
unsigned long lastProgressAckAt = 0;
char activeCommandId[80] = "none";
int activeDurationSeconds = 0;
float activeLitersTarget = 0;
float activeFlowLitersPerMinute = DEFAULT_FLOW_LITERS_PER_MINUTE;
float lastConfiguredFlowLitersPerMinute = DEFAULT_FLOW_LITERS_PER_MINUTE;
char commandTopic[128];
char ackTopic[128];
char wildcardCommandTopic[128];
char defaultCommandTopic[128];

float clampFloat(float value, float minimum, float maximum);

String chipUid() {
  uint64_t mac = ESP.getEfuseMac();
  char uid[24];
  snprintf(uid, sizeof(uid), "esp32-%04X%08X", (uint16_t)(mac >> 32), (uint32_t)mac);
  return String(uid);
}

String platformUrl(const char* path) {
  return String(PLATFORM_BASE_URL) + path;
}

String platformUrl(const String& path) {
  return String(PLATFORM_BASE_URL) + path;
}

void refreshMqttTopics() {
  snprintf(commandTopic, sizeof(commandTopic), "farms/%d/devices/%s/commands", activeLandId, DEVICE_UID);
  snprintf(ackTopic, sizeof(ackTopic), "farms/%d/devices/%s/ack", activeLandId, DEVICE_UID);
  snprintf(wildcardCommandTopic, sizeof(wildcardCommandTopic), "farms/+/devices/%s/commands", DEVICE_UID);
  snprintf(defaultCommandTopic, sizeof(defaultCommandTopic), "farms/%d/devices/%s/commands", DEFAULT_LAND_ID, DEVICE_UID);
}

void saveActiveLandId() {
  preferences.putInt("land_id", activeLandId);
}

void subscribeCommandTopics() {
  if (!mqtt.connected()) return;
  refreshMqttTopics();
  mqtt.subscribe(commandTopic);
  mqtt.subscribe(wildcardCommandTopic);
  mqtt.subscribe(defaultCommandTopic);
  Serial.print("Subscribed command topic: ");
  Serial.println(commandTopic);
  Serial.print("Subscribed wildcard topic: ");
  Serial.println(wildcardCommandTopic);
}

void setActiveLandId(int landId, bool persist) {
  if (landId <= 0) return;
  bool changed = landId != activeLandId;
  activeLandId = landId;
  refreshMqttTopics();
  if (persist) saveActiveLandId();
  if (changed) {
    Serial.print("Active land changed to: ");
    Serial.println(activeLandId);
    subscribeCommandTopics();
  }
}

void setRelay(bool on) {
  relayCommandedOn = on;
  if (on) {
    // Active-low relay ON: actively pull IN to GND.
    digitalWrite(RELAY_PIN, LOW);
    pinMode(RELAY_PIN, OUTPUT);
  } else {
    // Active-low relay OFF: release IN like the jumper is disconnected.
    // This avoids 3.3V HIGH being misread by some 5V relay modules.
    pinMode(RELAY_PIN, INPUT);
  }
}

bool relayIsOn() {
  return relayCommandedOn;
}

int activeElapsedSeconds() {
  if (!valveRunning && valveStartedAt == 0) return 0;
  return (int)((millis() - valveStartedAt) / 1000UL);
}

int activeRemainingSeconds() {
  if (!valveRunning) return 0;
  int remaining = activeDurationSeconds - activeElapsedSeconds();
  return remaining > 0 ? remaining : 0;
}

float activeWaterSpentLiters() {
  float elapsed = (float)activeElapsedSeconds();
  float spent = activeFlowLitersPerMinute * (elapsed / 60.0);
  if (activeLitersTarget > 0 && spent > activeLitersTarget) return activeLitersTarget;
  return spent;
}

float activeProgressPercent() {
  if (activeDurationSeconds <= 0) return 0.0;
  float progress = ((float)activeElapsedSeconds() / (float)activeDurationSeconds) * 100.0;
  return clampFloat(progress, 0.0, 100.0);
}

float clampFloat(float value, float minimum, float maximum) {
  if (value < minimum) return minimum;
  if (value > maximum) return maximum;
  return value;
}

float readSoilMoisturePercent() {
  int raw = analogRead(SOIL_MOISTURE_PIN);
  float percent = ((float)(SOIL_DRY_RAW - raw) / (float)(SOIL_DRY_RAW - SOIL_WET_RAW)) * 100.0;
  return clampFloat(percent, 0.0, 100.0);
}

float readTankLevelPercent() {
  int raw = analogRead(TANK_LEVEL_PIN);
  float level = ((float)(raw - TANK_EMPTY_RAW) / (float)(TANK_FULL_RAW - TANK_EMPTY_RAW)) * 100.0;
  return clampFloat(level, 0.0, 100.0);
}

void postJson(const String& url, const char* payload) {
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  if (url.startsWith("https://")) {
    http.begin(httpsClient, url);
  } else {
    http.begin(url);
  }
  http.addHeader("Content-Type", "application/json");
  if (strlen(PLATFORM_IOT_TOKEN) > 0) {
    http.addHeader("X-IoT-Token", PLATFORM_IOT_TOKEN);
  }
  int code = http.POST(payload);
  Serial.print("HTTP POST ");
  Serial.print(url);
  Serial.print(" -> ");
  Serial.println(code);
  http.end();
}

void refreshDeviceConfig(bool force) {
  if (WiFi.status() != WL_CONNECTED) return;
  if (!force && lastDeviceConfigRefreshAt > 0 && millis() - lastDeviceConfigRefreshAt < DEVICE_CONFIG_REFRESH_INTERVAL_MS) return;

  lastDeviceConfigRefreshAt = millis();
  HTTPClient http;
  String url = platformUrl(String("/api/iot/device-config?device_uid=") + DEVICE_UID);
  if (url.startsWith("https://")) {
    http.begin(httpsClient, url);
  } else {
    http.begin(url);
  }
  if (strlen(PLATFORM_IOT_TOKEN) > 0) {
    http.addHeader("X-IoT-Token", PLATFORM_IOT_TOKEN);
  }

  int code = http.GET();
  Serial.print("HTTP GET ");
  Serial.print(url);
  Serial.print(" -> ");
  Serial.println(code);

  if (code == 200) {
    StaticJsonDocument<768> doc;
    DeserializationError error = deserializeJson(doc, http.getString());
    if (!error) {
      int configuredLandId = doc["land_id"] | activeLandId;
      if (configuredLandId > 0) {
        setActiveLandId(configuredLandId, true);
      }
    } else {
      Serial.print("Device config JSON parse failed: ");
      Serial.println(error.c_str());
    }
  }

  http.end();
}

void publishAck(const char* commandId, const char* status, const char* relayState, int durationSeconds, float litersTarget, const char* message) {
  StaticJsonDocument<768> doc;
  doc["command_id"] = commandId;
  doc["land_id"] = activeLandId;
  doc["device_uid"] = DEVICE_UID;
  doc["status"] = status;
  doc["relay_state"] = relayState;
  doc["duration_seconds"] = durationSeconds;
  doc["liters_target"] = litersTarget;
  doc["elapsed_seconds"] = activeElapsedSeconds();
  doc["remaining_seconds"] = activeRemainingSeconds();
  doc["water_spent_liters"] = activeWaterSpentLiters();
  doc["progress_percent"] = activeProgressPercent();
  doc["flow_liters_per_minute"] = activeFlowLitersPerMinute;
  doc["message"] = message;
  doc["millis"] = millis();

  char payload[768];
  serializeJson(doc, payload);

  if (mqtt.connected()) {
    mqtt.publish(ackTopic, payload);
  }
  postJson(platformUrl("/api/iot/ack"), payload);

  Serial.print("ACK: ");
  Serial.println(payload);
}

void publishTelemetry() {
  StaticJsonDocument<768> doc;
  doc["land_id"] = activeLandId;
  doc["device_uid"] = DEVICE_UID;
  doc["valve_state"] = relayIsOn() ? "ON" : "OFF";
  doc["flow_liters_per_minute"] = valveRunning ? activeFlowLitersPerMinute : lastConfiguredFlowLitersPerMinute;
  doc["battery_percent"] = 100;
  doc["test_mode"] = !HAS_SOIL_MOISTURE_SENSOR && !HAS_TANK_SENSOR;
  doc["active_command_id"] = valveRunning ? activeCommandId : "";
  doc["elapsed_seconds"] = activeElapsedSeconds();
  doc["remaining_seconds"] = activeRemainingSeconds();
  doc["water_spent_liters"] = activeWaterSpentLiters();
  doc["progress_percent"] = activeProgressPercent();

  if (HAS_SOIL_MOISTURE_SENSOR) {
    doc["soil_moisture_raw"] = analogRead(SOIL_MOISTURE_PIN);
    doc["soil_moisture_percent"] = readSoilMoisturePercent();
  }

  if (HAS_TANK_SENSOR) {
    doc["tank_capacity_liters"] = TANK_CAPACITY_LITERS;
    doc["tank_sensor_source"] = "hw_038_analog";
    doc["tank_raw"] = analogRead(TANK_LEVEL_PIN);
    float tankLevelPercent = readTankLevelPercent();
    if (tankLevelPercent >= 0) {
      doc["tank_level_percent"] = tankLevelPercent;
      doc["tank_volume_liters"] = TANK_CAPACITY_LITERS * (tankLevelPercent / 100.0);
    }
  }

  char payload[768];
  serializeJson(doc, payload);
  Serial.print("Telemetry: ");
  Serial.println(payload);
  postJson(platformUrl("/api/iot/telemetry"), payload);
}

void stopValve(const char* status, const char* message) {
  setRelay(false);
  publishAck(activeCommandId, status, "OFF", activeDurationSeconds, activeLitersTarget, message);
  valveRunning = false;
  valveStopAt = 0;
  valveStartedAt = 0;
  lastProgressAckAt = 0;
}

void forceStopValve(const char* commandId, const char* message) {
  const char* ackCommandId = strlen(commandId) > 0 ? commandId : activeCommandId;
  setRelay(false);
  publishAck(ackCommandId, "forced_off", "OFF", activeDurationSeconds, activeLitersTarget, message);
  valveRunning = false;
  valveStopAt = 0;
  valveStartedAt = 0;
  lastProgressAckAt = 0;
  activeDurationSeconds = 0;
  activeLitersTarget = 0;
  activeFlowLitersPerMinute = lastConfiguredFlowLitersPerMinute;
  activeCommandId[0] = '\0';
  publishTelemetry();
}

void startValve(const char* commandId, int commandLandId, int durationSeconds, float litersTarget, float flowLitersPerMinute) {
  strncpy(activeCommandId, commandId, sizeof(activeCommandId) - 1);
  activeCommandId[sizeof(activeCommandId) - 1] = '\0';
  setActiveLandId(commandLandId > 0 ? commandLandId : DEFAULT_LAND_ID, true);
  activeDurationSeconds = durationSeconds;
  activeLitersTarget = litersTarget;
  activeFlowLitersPerMinute = flowLitersPerMinute > 0 ? flowLitersPerMinute : DEFAULT_FLOW_LITERS_PER_MINUTE;
  lastConfiguredFlowLitersPerMinute = activeFlowLitersPerMinute;

  valveRunning = true;
  valveStartedAt = millis();
  lastProgressAckAt = millis();
  valveStopAt = millis() + ((unsigned long)durationSeconds * 1000UL);
  setRelay(true);
  publishAck(activeCommandId, "started", "ON", durationSeconds, litersTarget, "Valve opened by AgriAI command");
  publishTelemetry();
}

void handleCommand(char* topic, byte* payload, unsigned int length) {
  Serial.print("MQTT command on ");
  Serial.println(topic);

  StaticJsonDocument<1024> doc;
  DeserializationError error = deserializeJson(doc, payload, length);
  if (error) {
    publishAck("unknown", "failed_json_parse", relayIsOn() ? "ON" : "OFF", 0, 0, error.c_str());
    return;
  }

  const char* commandId = doc["command_id"] | "unknown";
  const char* status = doc["status"] | "OFF";
  int commandLandId = doc["land_id"] | activeLandId;
  if (commandLandId <= 0) commandLandId = activeLandId;
  setActiveLandId(commandLandId, true);
  int durationSeconds = doc["duration_seconds"] | 0;
  float litersTarget = doc["liters_target"].isNull() ? 0.0 : doc["liters_target"].as<float>();
  float flowLitersPerMinute = doc["flow_rate_liters_per_minute"].isNull()
    ? lastConfiguredFlowLitersPerMinute
    : doc["flow_rate_liters_per_minute"].as<float>();
  if (flowLitersPerMinute <= 0) flowLitersPerMinute = DEFAULT_FLOW_LITERS_PER_MINUTE;
  lastConfiguredFlowLitersPerMinute = flowLitersPerMinute;

  if (strcmp(status, "OFF") == 0) {
    forceStopValve(commandId, valveRunning ? "OFF command received; valve closed" : "OFF command received; valve already closed");
    return;
  }

  if (strcmp(status, "ON") != 0) {
    publishAck(commandId, "rejected_unknown_status", relayIsOn() ? "ON" : "OFF", durationSeconds, litersTarget, "Only ON/OFF commands are accepted");
    return;
  }

  if (durationSeconds <= 0 || durationSeconds > MAX_DURATION_SECONDS) {
    publishAck(commandId, "rejected_invalid_duration", "OFF", durationSeconds, litersTarget, "Duration must be 1..7200 seconds");
    return;
  }

  if (valveRunning) {
    publishAck(commandId, "rejected_busy", "ON", durationSeconds, litersTarget, "Valve is already running another command");
    return;
  }

  startValve(commandId, commandLandId, durationSeconds, litersTarget, flowLitersPerMinute);
}

void connectWifiIfNeeded() {
  if (WiFi.status() == WL_CONNECTED) return;
  if (millis() - lastWifiReconnectAt < WIFI_RECONNECT_INTERVAL_MS) return;

  lastWifiReconnectAt = millis();
  Serial.println("Connecting WiFi...");
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

void connectMqttIfNeeded() {
  if (WiFi.status() != WL_CONNECTED || mqtt.connected()) return;
  if (millis() - lastMqttReconnectAt < MQTT_RECONNECT_INTERVAL_MS) return;

  lastMqttReconnectAt = millis();
  Serial.println("Connecting MQTT...");
  if (mqtt.connect(DEVICE_UID, MQTT_USER, MQTT_PASSWORD)) {
    Serial.println("MQTT connected");
    subscribeCommandTopics();
    publishAck("boot", "online", relayIsOn() ? "ON" : "OFF", 0, 0, "ESP32 connected and subscribed");
  } else {
    Serial.print("MQTT failed, state=");
    Serial.println(mqtt.state());
  }
}

void setup() {
  Serial.begin(115200);

  // Active-low relay safety: keep IN released before any delay, WiFi, or MQTT work.
  pinMode(RELAY_PIN, INPUT);
  setRelay(false);

  delay(500);

  preferences.begin("agriai", false);
  activeLandId = preferences.getInt("land_id", DEFAULT_LAND_ID);
  if (activeLandId <= 0) activeLandId = DEFAULT_LAND_ID;
  refreshMqttTopics();

  analogReadResolution(12);
  pinMode(SOIL_MOISTURE_PIN, INPUT);
  pinMode(TANK_LEVEL_PIN, INPUT);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  secureClient.setInsecure();
  httpsClient.setInsecure();
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(handleCommand);
  mqtt.setBufferSize(1024);

  Serial.println("AgriAI ESP32 irrigation controller booted");
  Serial.print("ESP32 chip UID: ");
  Serial.println(chipUid());
  Serial.print("WiFi MAC: ");
  Serial.println(WiFi.macAddress());
  Serial.print("Platform device UID: ");
  Serial.println(DEVICE_UID);
  Serial.print("Platform URL: ");
  Serial.println(PLATFORM_BASE_URL);
  Serial.print("Active land ID: ");
  Serial.println(activeLandId);
  Serial.print("Command topic: ");
  Serial.println(commandTopic);
  Serial.print("Wildcard command topic: ");
  Serial.println(wildcardCommandTopic);
}

void loop() {
  connectWifiIfNeeded();
  refreshDeviceConfig(false);
  connectMqttIfNeeded();

  if (mqtt.connected()) {
    mqtt.loop();
  }

  if (valveRunning && (long)(millis() - valveStopAt) >= 0) {
    stopValve("completed", "Duration elapsed; valve closed");
  }

  if (valveRunning && millis() - lastProgressAckAt >= PROGRESS_ACK_INTERVAL_MS) {
    lastProgressAckAt = millis();
    publishAck(activeCommandId, "progress", "ON", activeDurationSeconds, activeLitersTarget, "Valve still running");
  }

  unsigned long telemetryInterval = valveRunning ? ACTIVE_TELEMETRY_INTERVAL_MS : TELEMETRY_INTERVAL_MS;
  if (millis() - lastTelemetryAt >= telemetryInterval) {
    lastTelemetryAt = millis();
    publishTelemetry();
  }
}
