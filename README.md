# nova-airguard-final-2026

## AirGuard: 校园多区域空气质量与人流监测预警协同系统

## 项目简介
宿舍环境监测系统，基于MQTT，包含感知节点、Web监测页面、移动端、3D可视化模块。

## 环境依赖
Python3.8+、pandas、matplotlib、Mosquitto MQTT Broker

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

## 启动顺序
1. 启动MQTT Broker
2. 启动感知节点，上传温湿度数据
3. 打开Web监测页面
4. 移动端、3D地图同步查看数据

## 前置项目
前置R18项目仓库：https://github.com/sunxiubing/nova-dormmate-final-2026
