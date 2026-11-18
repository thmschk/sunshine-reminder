# Basis-Image bewusst ohne Digest: update-docker-images.sh baut wöchentlich mit frischem python:3.13-slim neu.
FROM python:3.13-slim AS base
# Kennzeichen für deploy.sh: räumt unbenannte Reste nur mit diesem Label ab.
LABEL de.sunshine-order.app=push
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir --require-hashes -r requirements.txt
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 DATA_DIR=/data

# Tests bei jedem Bau: scheitern sie (etwa mit einem kaputten neuen Basis-Image), scheitert der
# Bau, und der laufende Container bleibt. Ohne Netz; der Vertragstest mit web/push.js wird
# hier übersprungen, weil web/ nicht im Build-Kontext liegt.
FROM base AS test
COPY app.py test_app.py ./
RUN python -m unittest -q test_app && touch /tests-ok

FROM base
# Nur damit BuildKit die Test-Stage nicht überspringt; die Datei ist leer.
COPY --from=test /tests-ok /tests-ok
COPY app.py .
USER 1000:1000
CMD ["python", "app.py"]
