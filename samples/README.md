# ROS 2 Extension Samples

This directory contains sample ROS 2 packages and configurations to demonstrate the features of the ROS 2 extension.

## Launch Configuration Examples

### Using envFile

The `.env.sample` file demonstrates how to define environment variables in a file that can be loaded by the launch configuration.

Example launch.json configuration:
```json
{
    "name": "ROS2: Launch with envFile",
    "type": "ros2",
    "request": "launch",
    "target": "${workspaceFolder}/samples/src/rde_py/launch/rde_publisher.launch.py",
    "envFile": "${workspaceFolder}/samples/.env.sample"
}
```

### Combining env and envFile

You can use both `env` and `envFile` together. Variables in `env` take precedence:
```json
{
    "name": "ROS2: Launch with env and envFile",
    "type": "ros2",
    "request": "launch",
    "target": "${workspaceFolder}/samples/src/rde_py/launch/rde_publisher.launch.py",
    "envFile": "${workspaceFolder}/samples/.env.sample",
    "env": {
        "ROS_DOMAIN_ID": "99"
    }
}
```

See `launch.json.example` for more examples.

## Sample Packages

All sample packages live under `src/` (standard ROS 2 workspace layout):

- **rde_cpp**: C++ ROS 2 package examples (`src/rde_cpp`)
- **rde_py**: Python ROS 2 package examples (`src/rde_py`)
- **msg_interfaces**: custom message/service/action interfaces (`src/msg_interfaces`)
- **rde_lifecycle_cpp**: C++ lifecycle node examples (`src/lifecycle_cpp`)
- **rde_lifecycle_py**: Python lifecycle node examples (`src/rde_lifecycle_py`)
- **rde_launch_examples**: launch examples (`src/launch_examples`)
- **msg_interfaces**: Custom message interface examples
