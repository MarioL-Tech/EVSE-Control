#include <Arduino.h>


void setup() {
  // Serial2 uses GPIO 16 (RX) and 17 (TX) on most ESP32s
  Serial2.begin(115200, SERIAL_8N1, 16, 17); 
}

void loop() {
  // Send a test message to the Pi every 2 seconds
  Serial2.println("EV_STATUS:READY");
  delay(2000);
}