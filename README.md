# StayOps 房源清洁日历

这是带共享数据和 iCal 服务器同步的 StayOps 版本。GitHub 用来保存代码；由于 GitHub Pages 不能运行后端，本版本需要部署到支持 Node.js 20+ 或 Docker 的服务器。

## 启动

```bash
npm start
```

默认访问地址为 `http://localhost:3000`。正式部署时必须给 `/app/data`（或环境变量 `DATA_DIR` 指定的目录）配置持久化磁盘，否则服务器重建后数据会丢失。

## Docker

```bash
docker build -t stayops .
docker run -p 3000:3000 -v stayops-data:/app/data stayops
```

管理员保存真实 iCal 地址后，服务器会代替浏览器读取日历，因此不再受 Booking/Airbnb 浏览器跨域限制。
服务器默认每10分钟自动同步全部房源，可用环境变量 `ICAL_SYNC_INTERVAL_MS` 调整间隔。

## 设备说明

- 页面已适配手机、平板和电脑，并带有移动端布局。
- 页面不依赖外部脚本，国内打开时不会等待第三方翻译服务。
- 手机、电脑及员工端从服务器读取同一份共享数据；浏览器仍保留本地缓存作为临时备用。
