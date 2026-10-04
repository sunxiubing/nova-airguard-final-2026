# nova-airguard-final-2026

## AirGuard: 校园多区域空气质量与人流监测预警协同系统

## 项目简介
宿舍环境监测系统，基于MQTT，包含感知节点、Web监测页面、移动端、3D可视化模块。

## 环境依赖
- 系统：Windows10/11
- MQTT服务：Mosquitto本地Broker
- 测试工具：MQTTX
- Python：python3，pandas（python_analysis模块）
- 前端库：Three.js、mqtt.js、Chart.js
- 编辑器：VS Code + Live Server

## 目录说明
- web：网页监测面板
- mobile：移动端页面
- map3d：三维可视化页面
- python_analysis：数据分析脚本
- docs：项目文档、答辩材料
- evidence：实验证据目录
    - Challenge：前置DormMate项目索引
    - D1~D5：功能验证证据
    - E1~E3：拓展验证证据
    - Debug：调试记录
    - Reproduce：复现步骤
    - Open：开放拓展内容


## 依赖安装与配置
1. 安装Mosquitto，开启WebSocket端口
2. python_analysis目录：创建venv虚拟环境，安装pandas
3. VS Code安装Live Server，用于网页预览

## 完整启动顺序
1. 启动本地Mosquitto MQTT Broker
2. 启动python_analysis分析服务
3. MQTTX连接本地Broker
4. Live Server启动web监测台
5. 打开mobile移动端页面
6. 打开map3d 3D地图页面

##  MQTT基础配置
- Broker地址：`ws://127.0.0.1:8085`
- Topic：`campus/building/sensor`
- 报文字段：zone, pm25, co2, crowd_level,time

##  生成测试数据
MQTTX向topic发送JSON报文，示例重度污染：
`{"zoneId":"zone-w","pm25":343,"co2":1210,"crowdLevel":3,"status":"重度污染","time":"2026-10-4 17:27:00"}`

##  Web—移动端实时同步验证
MQTTX发送测试报文，同时打开web页面、mobile移动端页面。
两者指标、告警状态、事件记录同步刷新。

##  D1-D5快速复现
- D1：MQTT发送多组数据，验证数据质量校验（合格/存疑/不合格）
- D2：多区域同时告警，自动计算优先级，标记优先关注区域
- D3：事件流转：未处理 → 干预中 → 已恢复；支持干预动作记录
- D4：固定规则与ML稳健z值并列展示；协同裁决采用规则优先
- D5：整套事件全流程写入Report历史报告；map3d 3D模型联动更新灯带、告警文字、优先黄圈

##  预期运行结果
1. 收到异常MQTT数据：对应教学楼标记优先关注；3D灯带变色，楼顶告警文字、优先黄圈显示。
2. 前端执行干预动作（开启新风/喷雾降尘/限流疏导），状态切换【处理中】，web/mobile/3D同步更新。
3. MQTT下发恢复数据，判定【已恢复】；3D灯带切回正常色，告警文字清除，优先黄圈移除。
4. 事件完整链路存入Report，历史记录持续保存，不会覆盖旧记录。

##  常见问题排查
1. MQTT收不到数据：检查Mosquitto是否启动、WebSocket端口、topic名称一致。
2. 3D模型不更新：确认MQTT连接成功，刷新Live Server页面。
3. Report无新增记录：检查报文字段名称匹配，python分析服务正常运行。
4. python报错：确认venv虚拟环境已激活，pandas安装完成。

##  已知限制
1. ML基于历史统计样本，若历史数据长期超标，会把超标识别为本区域常态，需配合固定规则综合判断。
2. 仅支持zone-w、zone-n、zone-s三栋楼。。

##  开源库来源
Three.js、mqtt.js、Chart.js、pandas

## 前置项目
前置R18项目仓库：https://github.com/sunxiubing/nova-dormmate-final-2026
