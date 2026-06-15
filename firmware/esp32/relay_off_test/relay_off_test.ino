const int RELAY_PIN = 27;

// Most blue 1-channel relay modules are ACTIVE LOW:
// IN = LOW        -> relay ON
// IN disconnected -> relay OFF on your module

void setup() {
  Serial.begin(115200);

  // Safe OFF: release IN like the jumper is disconnected.
  pinMode(RELAY_PIN, INPUT);

  Serial.println("Relay OFF test started");
  Serial.println("GPIO27 is INPUT/disconnected. Relay should be OFF. Pump must be OFF.");
}

void loop() {
  pinMode(RELAY_PIN, INPUT);
  Serial.println("Relay input released OFF");
  delay(2000);
}
