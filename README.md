# 妙手全自动上架辅助系统

按交互原型实现的采集 → 公共采集箱 → TK 采集箱 → 校验 → 多店发布工作台。

## 启动

```bash
npm install
npm run dev
```

浏览器打开 http://localhost:5173 。前端走 Vite，接口代理到 http://localhost:8787 。

采集箱、店铺和任务列表都来自妙手接口，本地不放样品商品。

## 对接妙手开放平台

把 App Key / App Secret 放在项目根目录 `.env`（不要提交到 git）：

```
MIAOSHOU_MODE=live
MIAOSHOU_BASE_URL=https://openapi-erp.91miaoshou.com
MIAOSHOU_APP_KEY=ak_xxx
MIAOSHOU_APP_SECRET=xxx
```

签名与测试脚本一致：

`HMAC-SHA256(secret, secret + path + timestamp + appKey + bodyJson + secret)`

请求头：`x-app-key`、`x-timestamp`、`x-sign`。时间戳为秒；`bodyJson` 必须与请求体字节级一致。

已对接接口：

- `POST /open/v1/product/shop/shop/get_shop_list`
- `POST /open/v1/product/common_collect_box/common_collect_box/fetch_item`
- `POST /open/v1/product/common_collect_box/common_collect_box/get_common_collect_box_detail`
- `POST /open/v1/product/common_collect_box/common_collect_box/claimed`
- `POST /open/v1/product/collect_box/tiktok/collect_box/search_collect_box_detail_list`
- `POST /open/v1/product/collect_box/tiktok/collect_box/get_shop_collect_item_info`
- `POST /open/v1/product/collect_box/tiktok/collect_box/save_shop_collect_item_info`
- 站点模式 get/save_site_collect_item_info

## 安全策略

命中风险词（如「正品」）、缺少店铺、毛利低于阈值时，该商品进入异常列表，其它商品继续处理。
