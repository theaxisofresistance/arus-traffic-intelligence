/*
 * ARUS IoT sender — ESP8266 + u-blox NEO-6M
 *
 * Library tambahan (Arduino Library Manager): TinyGPSPlus by Mikal Hart
 * Board package: esp8266 by ESP8266 Community
 *
 * Wiring NEO-6M (ubah pin di bawah bila board Anda berbeda):
 *   NEO-6M VCC -> 3V3/5V sesuai modul breakout
 *   NEO-6M GND -> GND
 *   NEO-6M TX  -> D5 / GPIO 14 (GPS_RX_PIN)
 *   NEO-6M RX  -> D6 / GPIO 12 (GPS_TX_PIN, opsional)
 *
 * Isi daftar WIFI_NETWORKS dan SERVER_URL sebelum upload.
 * SERVER_URL harus memakai IP LAN komputer Flask, bukan 127.0.0.1.
 */

#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClientSecureBearSSL.h>
#include <SoftwareSerial.h>
#include <TinyGPSPlus.h>

struct WifiCredential {
  const char *ssid;
  const char *password;
};

const WifiCredential WIFI_NETWORKS[] = {
  {"Azhar Rudin's iPhone", "12345678"}
};

constexpr size_t WIFI_COUNT = sizeof(WIFI_NETWORKS) / sizeof(WIFI_NETWORKS[0]);
constexpr uint32_t WIFI_TIMEOUT_MS = 12000UL;
constexpr uint32_t WIFI_LED_BLINK_MS = 400UL;
const char *SERVER_URL = "https://arus-traffic-intelligence-zeta.vercel.app/api/iot/readings";
const char *DEVICE_ID = "sensor-001";

constexpr int GPS_RX_PIN = 14;  // D5 pada NodeMCU
constexpr int GPS_TX_PIN = 12;  // D6 pada NodeMCU; opsional
constexpr uint32_t GPS_BAUD = 9600;
constexpr uint32_t GPS_MAX_AGE_MS = 10000UL;

// Lokasi cadangan Sensor 001 — koridor Gatot Subroto.
constexpr double FALLBACK_LATITUDE = -6.229171;
constexpr double FALLBACK_LONGITUDE = 106.796941;

// PEMS08 direkam per 5 menit.
constexpr uint32_t SEND_INTERVAL_MS = 5UL * 60UL * 1000UL;

// LED biru onboard NodeMCU V3: D4 / GPIO2, aktif-low.
constexpr int STATUS_LED_PIN = 2;

TinyGPSPlus gps;
SoftwareSerial gpsSerial(GPS_RX_PIN, GPS_TX_PIN);
uint32_t lastSendMs = 0;
uint32_t lastLedBlinkMs = 0;
bool firstReadingPending = true;
bool ledBlinkState = true;

void setupStatusLed() {
  pinMode(STATUS_LED_PIN, OUTPUT);
  digitalWrite(STATUS_LED_PIN, LOW);
}

void setStatusLed(bool on) {
  digitalWrite(STATUS_LED_PIN, on ? LOW : HIGH);
}

void updateDisconnectedLed() {
  const uint32_t now = millis();
  if (now - lastLedBlinkMs < WIFI_LED_BLINK_MS) return;
  lastLedBlinkMs = now;
  ledBlinkState = !ledBlinkState;
  setStatusLed(ledBlinkState);
}

void readGps() {
  while (gpsSerial.available() > 0) {
    gps.encode(gpsSerial.read());
  }
}

void connectWifi() {
  if (WiFi.status() == WL_CONNECTED) return;

  WiFi.mode(WIFI_STA);
  WiFi.persistent(false);

  for (size_t index = 0; index < WIFI_COUNT; ++index) {
    const WifiCredential &network = WIFI_NETWORKS[index];
    if (network.ssid[0] == '\0') continue;

    WiFi.disconnect();
    delay(100);
    Serial.printf("Mencoba Wi-Fi %u/%u: %s", index + 1, WIFI_COUNT, network.ssid);
    WiFi.begin(network.ssid, network.password);

    const uint32_t startedAt = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - startedAt < WIFI_TIMEOUT_MS) {
      readGps();
      updateDisconnectedLed();
      delay(100);
      Serial.print('.');
    }
    Serial.println();

    if (WiFi.status() == WL_CONNECTED) {
      Serial.printf("Wi-Fi tersambung ke %s. IP ESP8266: ", network.ssid);
      Serial.println(WiFi.localIP());
      return;
    }

    Serial.printf("Gagal tersambung ke %s. Mencoba jaringan berikutnya.\n", network.ssid);
  }

  Serial.println("Semua Wi-Fi gagal; daftar akan dicoba lagi pada siklus berikutnya.");
}

float randomFloat(float minimum, float maximum) {
  const float fraction = static_cast<float>(random(0, 1000001)) / 1000000.0f;
  return minimum + fraction * (maximum - minimum);
}

String gpsTimestamp() {
  if (!gps.date.isValid() || !gps.time.isValid() ||
      gps.date.age() > GPS_MAX_AGE_MS || gps.time.age() > GPS_MAX_AGE_MS) return "";

  char timestamp[25];
  snprintf(timestamp, sizeof(timestamp), "%04d-%02d-%02dT%02d:%02d:%02dZ",
           gps.date.year(), gps.date.month(), gps.date.day(),
           gps.time.hour(), gps.time.minute(), gps.time.second());
  return String(timestamp);
}

bool sendReading() {
  // LED normalnya menyala dan hanya padam selama proses pengiriman.
  setStatusLed(false);

  connectWifi();
  if (WiFi.status() != WL_CONNECTED) {
    updateDisconnectedLed();
    return false;
  }
  setStatusLed(false);

  // Nilai trafik otomatis. Kecepatan dibuat berbanding terbalik dengan occupancy.
  const float occupancy = randomFloat(5.0f, 75.0f);       // persen
  const float flow = randomFloat(40.0f, 420.0f);           // kendaraan/5 menit
  const float speed = max(8.0f, 88.0f - occupancy * 0.75f + randomFloat(-7.0f, 7.0f));

  String payload;
  payload.reserve(256);
  payload += "{\"device_id\":\"";
  payload += DEVICE_ID;
  payload += "\",\"flow\":";
  payload += String(flow, 2);
  payload += ",\"occupancy\":";
  payload += String(occupancy, 2);
  payload += ",\"speed\":";
  payload += String(speed, 2);
  const bool gpsReady = gps.location.isValid() && gps.location.age() <= GPS_MAX_AGE_MS;
  const double latitude = gpsReady ? gps.location.lat() : FALLBACK_LATITUDE;
  const double longitude = gpsReady ? gps.location.lng() : FALLBACK_LONGITUDE;
  payload += ",\"latitude\":";
  payload += String(latitude, 6);
  payload += ",\"longitude\":";
  payload += String(longitude, 6);
  if (!gpsReady) {
    Serial.println("GPS tidak valid; memakai lokasi cadangan Sensor 001.");
  }

  const String timestamp = gpsTimestamp();
  if (timestamp.length() > 0) {
    payload += ",\"timestamp\":\"";
    payload += timestamp;
    payload += "\"";
  }
  payload += "}";

  BearSSL::WiFiClientSecure client;
  // Koneksi HTTPS menuju endpoint operasional.
  client.setInsecure();
  HTTPClient http;
  http.setTimeout(10000);

  if (!http.begin(client, SERVER_URL)) {
    Serial.println("URL server tidak valid.");
    setStatusLed(true);
    return false;
  }

  http.addHeader("Content-Type", "application/json");
  const int statusCode = http.POST(payload);
  const String response = statusCode > 0 ? http.getString() : String("HTTP error ") + statusCode;
  http.end();

  Serial.printf("POST status: %d\n", statusCode);
  Serial.println(payload);
  Serial.println(response);
  const bool success = statusCode >= 200 && statusCode < 300;
  setStatusLed(true);
  return success;
}

void setup() {
  Serial.begin(115200);
  setupStatusLed();
  gpsSerial.begin(GPS_BAUD);
  randomSeed(micros() ^ ESP.getChipId());
  delay(500);

  Serial.println("ARUS IoT sender dimulai.");
  connectWifi();
  if (WiFi.status() == WL_CONNECTED) setStatusLed(true);
}

void loop() {
  readGps();

  const uint32_t now = millis();
  const bool sendDue = firstReadingPending || now - lastSendMs >= SEND_INTERVAL_MS;
  if (sendDue) {
    sendReading();
    lastSendMs = millis();
    firstReadingPending = false;
  }

  if (WiFi.status() != WL_CONNECTED) {
    updateDisconnectedLed();
  }

  delay(10);
}
