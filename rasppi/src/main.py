import paho.mqtt.client as mqtt
import serial

# Setup MQTT Client for Version 2
client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2) 

# Connect to the local broker you just fixed
client.connect("127.0.0.1", 1883, 60)
print("Pi is now listening for the ESP32...")
# Open the serial port at 9600 baud rate
ser = serial.Serial('/dev/serial0', 115200, timeout=1)

client.loop_start()

try:
    while True:
        # This keeps the script running so it can receive Serial data
        if ser.in_waiting > 0:
            line = ser.readline().decode('utf-8').rstrip()
            print(f"Received from ESP32: {line}")
            # Optional: Publish to MQTT
            client.publish("evse/status", line)
except KeyboardInterrupt:
    print("Script stopped by user")
finally:
    ser.close() 