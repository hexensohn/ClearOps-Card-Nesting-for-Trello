FROM python:3.12-slim

WORKDIR /app

COPY backend /app/backend
COPY public /app/public

ENV PORT=80
ENV SQLITE_PATH=/data/card_nesting.db

EXPOSE 80

CMD ["python", "backend/server.py"]
