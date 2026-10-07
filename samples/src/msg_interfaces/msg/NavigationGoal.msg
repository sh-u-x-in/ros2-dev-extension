# NavigationGoal.msg - Testing complex navigation message patterns
# Advanced message with nested structures and planning data

std_msgs/Header header

# Goal identification
string goal_id
uint32 priority                    # 1=high, 5=low
builtin_interfaces/Time deadline

# Target pose
geometry_msgs/PoseStamped target_pose
float64 position_tolerance       # Meters
float64 orientation_tolerance  # Radians (~5 degrees)

# Path planning constraints
float64 max_velocity             # m/s
float64 max_acceleration         # m/s²
float64 max_angular_velocity    # rad/s
bool use_global_planner
bool avoid_obstacles
string planner_id

# Waypoint sequence
geometry_msgs/PoseStamped[] waypoints
float64[] waypoint_tolerances
builtin_interfaces/Duration[] waypoint_timeouts

# Behavior parameters
uint8 behavior_type
uint8 BEHAVIOR_DIRECT=0
uint8 BEHAVIOR_EXPLORE=1
uint8 BEHAVIOR_PATROL=2
uint8 BEHAVIOR_FOLLOW=3

# Recovery behaviors
bool enable_recovery
string[] recovery_behaviors
float64[] recovery_timeouts

# Area constraints (polygon)
geometry_msgs/Point[] allowed_area
geometry_msgs/Point[] forbidden_areas

# Cost parameters
float64 obstacle_cost_scaling
float64 path_distance_bias
float64 goal_distance_bias
float64 occdist_scale

# Advanced options
bool preempt_current_goal
bool clear_costmaps
string map_frame
string base_frame
float64 controller_frequency    # Hz
float64 planner_frequency        # Hz

# Callback configurations
bool send_feedback
float64 feedback_frequency       # Hz
bool publish_path
bool publish_goal_markers