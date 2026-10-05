# Challenge 前置证据索引（DormMate R18）
本文件夹存放AirGuard项目**前置R18（DormMate）**证据索引，完整原始代码、截图、证据保存在独立仓库：
https://github.com/sunxiubing/nova-dormmate-final-2026

> 说明：R18阶段所有Commit不计入当前AirGuard仓库的≥5次有效Commit要求。AirGuard在DormMate已完成能力基础上扩展空气质量监测、ML偏离判定、多建筑三端同步、自动报告生成。

## DormMate R18 模块完成清单（M1~M6）
- M1 Web：Web页面，输入温湿度，完成校验、规则判断、时间历史记录。Web可稳定运行，新数据实时判断并生成历史曲线
- M2 离线分析：Web导出CSV，Python读取、统计绘图，自动输出trend.png和report.html；更换CSV文件可以重新生成报告
- M3 本机交互+版本记录：Web支持摄像头、语音识别ASR/语音合成TTS；本地Git仓库保存提交日志
- M4 移动端：微信小程序，复用同一套业务规则；新开页面输入数据，正确输出状态、建议
- M5 实时系统：本地Mosquitto MQTT Broker；MQTTX模拟dorm-a/dorm-b/dorm-c三个节点；JSON消息送入Dashboard，区分多节点，实时展示状态趋势
- M6 3D融合：Three.js搭建简易3D场景；MQTT消息实时驱动3D模型，≥2个对象、3种状态可视化

## 证据位置索引
- M1 Web证据：nova-dormmate-final-2026/Evidence/D1
- M2 离线分析证据：nova-dormmate-final-2026/Evidence/D2
- M3 本机交互+Git记录：nova-dormmate-final-2026/Evidence/D3
- M4 移动端小程序：nova-dormmate-final-2026/Evidence/D4
- M5 MQTT实时链路：nova-dormmate-final-2026/Evidence/D5
- M6 3D场景实时驱动：nova-dormmate-final-2026/Evidence/E1

## 前置能力复用说明
AirGuard复用DormMate底层能力：MQTT消息收发、JSON解析、多节点数据分发、Web/小程序/3D三端框架、CSV导出、报告生成。
在原有基础新增：PM2.5、CO₂监测，固定阈值判定，ML历史基线、偏离度计算，多栋楼宇（教学楼/食堂/宿舍楼）事件干预、自动判定恢复逻辑。

