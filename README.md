# 家常点菜网页版 🍚

店主提供菜单（可标新上线/在售/已下线，可增删改），朋友在菜单上勾选、约时间下单，店主收到后确认。

**零依赖**：不需要 `npm install`，只要服务器上有 Node（16 以上，建议 18+）。

## 一、拷到服务器并启动

```bash
# 1. 把整个 diancan-web 文件夹上传到服务器（scp 或任何方式）
scp -r diancan-web user@你的服务器IP:/home/user/

# 2. 登录服务器，启动
cd /home/user/diancan-web
node server.js
```

启动后：
- 网页地址：`http://服务器IP:3000`
- 控制台会打印 **首次自动生成的主人密码**（也写在 `data/db.json` 的 `config.adminPassword`，可手动改后重启）

## 二、常用启动方式

```bash
# 指定端口
PORT=8080 node server.js

# 后台常驻（关掉终端也不停）：最简单用 nohup
nohup node server.js > out.log 2>&1 &

# 或者用 pm2（可选，需先 npm i -g pm2）
pm2 start server.js --name diancan
pm2 save
```

## 三、安全组 / 防火墙放行端口

腾讯云控制台 → 轻量应用服务器（或 CVM）→ 防火墙 → 添加规则：放行 TCP 3000（或你设置的 PORT）。
云服务器本机如启用了 firewalld/ufw，也要放行对应端口。

## 四、（可选）用域名 + 80 端口

1. 域名解析 A 记录到服务器 IP
2. 用 nginx 反向代理：

```nginx
server {
    listen 80;
    server_name 你的域名;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
    }
}
```

> ⚠️ 提醒：中国大陆服务器上用域名对外提供网页服务，按工信部要求需要完成 ICP 备案；直接用 `IP:端口` 访问不受此限（但部分云厂商对未备案域名的 80/443 会拦截，IP 直连不受影响）。具体以服务器所在服务商与地区规则为准。

## 五、日常使用

| 谁 | 怎么用 |
|---|---|
| 朋友 | 打开网址 → 在菜单上**勾选**菜品（可调份数）→ 底部「预约下单」→ 选日期时间、写备注 → 提交 |
| 店主 | 打开网址 → 底部「管理」→ 输密码 → 「订单」里接单/婉拒/标记完成 → 「菜品管理」里增删改、标新上线/下线 |

- 菜品三种状态：**新上线**（菜单里带橙色 NEW 标）/ **在售** / **已下线**（朋友完全看不到）
- 同一个浏览器会自动记住身份，换个浏览器/设备就是"新朋友"
- **改密码**：编辑 `data/db.json` 里 `config.adminPassword`（明文存这个文件里，别泄露），重启生效
- **备份数据**：复制 `data/db.json` 一个文件即可；恢复 = 放回去重启

## 六、文件说明

```
diancan-web/
├── server.js          全部后端（零依赖 Node）
├── package.json
├── public/            前端（纯静态，无构建）
│   ├── index.html
│   ├── css/style.css
│   └── js/app.js
└── data/db.json       运行后自动生成，所有数据都在这
```

## 七、数据说明

- 菜品状态：`new 新上线 / on 在售 / off 已下线`；朋友菜单只显示前两种，价格由服务端按菜品表重算
- 订单状态：`pending 待确认 → cooking 制作中 → completed 已完成`；待确认可被店主婉拒（可填原因）或朋友自己取消
- 只有「已完成」的订单能评价，一单一评
