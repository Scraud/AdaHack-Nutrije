FROM python:3.12-slim
WORKDIR /srv/rescueflow
COPY pyproject.toml .
COPY app ./app
COPY alembic ./alembic
RUN python -m pip install --no-cache-dir .
ENV PYTHONUNBUFFERED=1 RESCUEFLOW_DB=/data/rescueflow.sqlite
EXPOSE 8000
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
