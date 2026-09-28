FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 TZ=Asia/Tokyo PYTHONPATH=/app
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY snsanalyzer ./snsanalyzer
COPY config.example.json ./
COPY templates ./templates
RUN useradd --create-home --uid 1000 app && mkdir -p /data && chown app /data
USER app
# 設定・DB・レポートはすべて /data（ボリューム）に置く
WORKDIR /data
EXPOSE 8000
CMD ["python", "-m", "snsanalyzer", "--config", "/data/config.json", "serve", "--host", "0.0.0.0", "--port", "8000", "--secure-cookies", "--trust-proxy"]
