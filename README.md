# nova-airguard-final-2026

## AirGuard：校园多区域空气质量与人流监测预警协同系统

### 项目简介
基于MQTT搭建的轻量数字孪生原型，包含感知采集、Web面板、移动端、3D可视化。实现PM2.5、CO₂、人流监测，支持阈值规则+ML偏离协同判定，三端同步，事件自动记录到报告。

### 环境依赖
- Windows10/11，VS Code + Live Server
- MQTT：公网broker.emqx.io（本地Mosquitto备用）
- MQTTX、Python3、pandas
- 前端库：Three.js、mqtt.js、Chart.js

### 目录
- web：网页监测面板
- mobile：移动端页面
- map3d：3D可视化
- python_analysis：数据分析脚本
- evidence：实验证据
  - Challenge：DormMate前置项目索引
  - D1~D5、E1~E3：功能验证
  - Debug：调试记录
 

### 安装与启动
1. 安装Mosquitto本地MQTT Broker
2. 进入python_analysis目录，启用venv虚拟环境，安装Python依赖
   ```bash
    pip install pandas matplotlib scikit-learn
3. 前端无需额外安装，用Live Server打开web/index.html
4. 移动端：微信开发者工具导入mobile文件夹
### 完整启动顺序（必须按顺序）
 - 启动本地Mosquitto MQTT Broker
​ - Live Server打开web/index.html启动Web监测台
​ - 微信开发者工具启动mobile移动端小程序
​ - 打开map3d里面3D数字孪生地图页面
 - 运行python_analysis下数据分析服务

### MQTT配置
- TCP：broker.emqx.io:1883
- WebSocket：wss://broker.emqx.io:8084/mqtt
- Topic：`Airguard-x9k2m/<区域>/data`，订阅`Airguard-x9k2m/+/data`
- 报文字段：zoneId, pm25, co2, crowdLevel, time

测试报文示例：
`{"zoneId":"zone-w","pm25":343,"co2":1210,"crowdLevel":3,"status":"重度污染","time":"2026-10-4 17:27:00"}`

### D1-D5复现
- D1：数据质量校验（合格/存疑/不合格）
- D2：多区域告警，自动计算优先级
- D3：事件流转：未处理→干预中→已恢复，记录干预操作
- D4：固定阈值+ML稳健z值，规则优先裁决，|偏离度|>2.5视为和历史明显不同
- D5：事件存入Report，3D场景联动灯带、告警标识

### E2 拓展功能
Web支持语音指令、摄像头拍照存档、TTS朗读结论；麦克风/摄像头需本地http服务打开。

### 手机真机联调
使用公网MQTT；微信开发者工具关闭urlCheck，仅用于开发调试。

### 预期效果
MQTT推送异常数据 → 页面告警、3D变色；标记干预；发送正常数据自动判定恢复；完整事件保存到报告。

### 常见问题
1. 收不到MQTT：检查网络、topic前缀`Airguard-x9k2m`，校园网可切热点测试
2. 报告不新增：确认python服务正常，报文字段无误
3. 语音/摄像头失效：用127.0.0.1本地http打开页面

### 已知限制
ML仅对比历史基线，历史本身超标时ML会判定为常态，风险以固定阈值为准；仅支持zone-w、zone-n、zone-s三个区域。

### 开源库
Three.js、mqtt.js、Chart.js、pandas

### 前置项目
DormMate前置仓库：https://github.com/sunxiubing/nova-dormmate-final-2026