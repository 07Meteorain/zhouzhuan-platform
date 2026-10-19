# 前端镜像：原生 HTML + Tailwind（CDN 引入，无构建步骤），由 nginx 提供静态服务
FROM nginx:1.27-alpine

# 清理默认页面，拷贝站点文件与 nginx 配置
RUN rm -rf /usr/share/nginx/html/*
COPY . /usr/share/nginx/html/
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 3000

CMD ["nginx", "-g", "daemon off;"]
