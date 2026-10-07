# RobotStatus.msg - Testing enumeration-like constants and status reporting
# Demonstrates common robotics status patterns

std_msgs/Header header

# Robot operational state
uint8 mode
uint8 MODE_MANUAL=0
uint8 MODE_AUTONOMOUS=1
uint8 MODE_SAFETY_STOP=2
uint8 MODE_MAINTENANCE=3

# System health
uint8 system_status
uint8 SYSTEM_HEALTHY=0
uint8 SYSTEM_DEGRADED=1
uint8 SYSTEM_CRITICAL=2
uint8 SYSTEM_OFFLINE=3

# Battery information
float32 battery_voltage        # Volts
float32 battery_current         # Amperes
uint8 battery_percentage          # 0-100%
bool battery_charging
builtin_interfaces/Duration estimated_runtime

# Network connectivity
bool wifi_connected
int8 wifi_signal_strength        # dBm
string wifi_ssid
bool ethernet_connected
uint32 packets_sent
uint32 packets_received
uint32 packet_loss_count

# Hardware status arrays
bool[] sensor_status                 # Dynamic array of sensor states
uint8[10] motor_temperatures         # Fixed array for 10 motors
float32[] joint_positions            # Current joint angles in radians
float32[] joint_velocities           # Joint velocities in rad/s

# Error reporting
uint16 error_code
string[] active_warnings
string[] active_errors
builtin_interfaces/Time last_error_time

# Performance metrics
float64 cpu_usage               # Percentage
float64 memory_usage           # MB
float64 disk_usage              # GB
float32 max_loop_time          # Seconds
float32 avg_loop_time          # Seconds

# Location and navigation
geometry_msgs/Pose current_pose
geometry_msgs/Twist current_velocity
bool navigation_active
string current_goal_id
float64 distance_to_goal         # Meters