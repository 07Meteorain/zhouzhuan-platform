# 后端镜像：FastAPI + SQLite，数据目录通过卷挂载持久化
FROM python:3.12-slim

# 中文字体与 SQLite 工具，便于水印渲染与排障
RUN apt-get update \
    && apt-get install -y --no-install-recommends fonts-wqy-zenhei tzdata sqlite3 \
    && rm -rf /var/lib/apt/lists/*

ENV TZ=Asia/Shanghai
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY app /app/app

# 数据目录：docker-compose 中将仓库 database/data 挂载到 /app/data
RUN mkdir -p /app/data/uploads

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
