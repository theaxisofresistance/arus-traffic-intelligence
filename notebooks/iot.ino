/*
 * ARUS IoT sender — ESP32-S3 + u-blox NEO-6M
 *
 * Library tambahan (Arduino Library Manager): TinyGPSPlus by Mikal Hart
 * Board package: esp32 by Espressif Systems
 *
 * Wiring NEO-6M (ubah pin di bawah bila board Anda berbeda):
 *   NEO-6M VCC -> 3V3/5V sesuai modul breakout
 *   NEO-6M GND -> GND
 *   NEO-6M TX  -> GPIO 18 (GPS_RX_PIN)
 *   NEO-6M RX  -> GPIO 17 (GPS_TX_PIN, opsional)
 *
 * Ganti WIFI_SSID, WIFI_PASSWORD, dan SERVER_URL sebelum upload.
 * SERVER_URL harus memakai IP LAN komputer Flask, bukan 127.0.0.1.
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <TinyGPSPlus.h>

const char *WIFI_SSID = "NAMA_WIFI";
const char *WIFI_PASSWORD = "PASSWORD_WIFI";
const char *SERVER_URL = "http://192.168.1.10:5001/api/iot/readings";
const char *DEVICE_ID = "esp32s3-001";

constexpr int GPS_RX_PIN = 18;
constexpr int GPS_TX_PIN = 17;
constexpr uint32_t GPS_BAUD = 9600;

// PEMS08 direkam per 5 menit.
constexpr uint32_t SEND_INTERVAL_MS = 5UL * 60UL * 1000UL;
constexpr uint32_t GPS_WARNING_INTERVAL_MS = 10UL * 1000UL;

TinyGPSPlus gps;
HardwareSerial gpsSerial(1);
uint32_t lastSendMs = 0;
uint32_t lastGpsWarningMs = 0;
bool firstReadingPending = true;

void readGps() {
  while (gpsSerial.available() > 0) {
    gps.encode(gpsSerial.read());
  }
}

void connectWifi() {
  if (WiFi.status() == WL_CONNECTED) return;

  Serial.printf("Menghubungkan ke Wi-Fi %s", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  const uint32_t startedAt = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - startedAt < 20000UL) {
    readGps();
    delay(100);
    Serial.print('.');
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("Wi-Fi tersambung. IP ESP32: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("Wi-Fi belum tersambung; akan dicoba lagi.");
  }
}

float randomFloat(float minimum, float maximum) {
  const float fraction = static_cast<float>(esp_random()) / static_cast<float>(UINT32_MAX);
  return minimum + fraction * (maximum - minimum);
}

String gpsTimestamp() {
  if (!gps.date.isValid() || !gps.time.isValid()) return "";

  char timestamp[25];
  snprintf(timestamp, sizeof(timestamp), "%04d-%02d-%02dT%02d:%02d:%02dZ",
           gps.date.year(), gps.date.month(), gps.date.day(),
           gps.time.hour(), gps.time.minute(), gps.time.second());
  return String(timestamp);
}

bool sendReading() {
  if (!gps.location.isValid()) {
    Serial.println("Belum ada GPS fix; pengiriman ditunda.");
    return false;
  }

  connectWifi();
  if (WiFi.status() != WL_CONNECTED) return false;

  // Nilai trafik simulasi. Kecepatan dibuat berbanding terbalik dengan occupancy
  // agar data acak tetap tampak masuk akal.
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
  payload += ",\"latitude\":";
  payload += String(gps.location.lat(), 6);
  payload += ",\"longitude\":";
  payload += String(gps.location.lng(), 6);

  const String timestamp = gpsTimestamp();
  if (timestamp.length() > 0) {
    payload += ",\"timestamp\":\"";
    payload += timestamp;
    payload += "\"";
  }
  payload += "}";

  WiFiClient client;
  HTTPClient http;
  http.setConnectTimeout(10000);
  http.setTimeout(10000);

  if (!http.begin(client, SERVER_URL)) {
    Serial.println("URL server tidak valid.");
    return false;
  }

  http.addHeader("Content-Type", "application/json");
  const int statusCode = http.POST(payload);
  const String response = statusCode > 0 ? http.getString() : http.errorToString(statusCode);
  http.end();

  Serial.printf("POST status: %d\n", statusCode);
  Serial.println(payload);
  Serial.println(response);
  return statusCode >= 200 && statusCode < 300;
}

void setup() {
  Serial.begin(115200);
  gpsSerial.begin(GPS_BAUD, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);
  delay(500);

  Serial.println("ARUS IoT sender dimulai.");
  connectWifi();
}

void loop() {
  readGps();

  const uint32_t now = millis();
  const bool sendDue = firstReadingPending || now - lastSendMs >= SEND_INTERVAL_MS;
  if (sendDue && gps.location.isValid()) {
    sendReading();
    lastSendMs = millis();
    firstReadingPending = false;
  } else if (sendDue && now - lastGpsWarningMs >= GPS_WARNING_INTERVAL_MS) {
    Serial.printf("Menunggu GPS fix... satelit: %u, karakter diproses: %lu\n",
                  gps.satellites.value(), gps.charsProcessed());
    lastGpsWarningMs = now;
  }

  delay(10);
}
