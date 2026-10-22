FROM python:3.13-slim
WORKDIR /app
COPY app.py engine.py research.py services.py index.html dashboard.js style.css ./
ENV PYTHONUNBUFFERED=1 HOST=0.0.0.0 PORT=10000 PAPER_LAB_DB=/data/bots-live.sqlite
EXPOSE 10000
CMD ["python", "app.py"]
