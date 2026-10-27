# Basis-Image bewusst ohne Digest: update-docker-images.sh baut wöchentlich mit frischem python:3.13-slim neu.
FROM python:3.13-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir --require-hashes -r requirements.txt
COPY app.py .
USER 1000:1000
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 DATA_DIR=/data
CMD ["python", "app.py"]
