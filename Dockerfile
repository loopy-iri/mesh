FROM python:3.11-alpine

WORKDIR /app

# Run as non-root user for security
RUN adduser -D -u 1000 appuser

# Copy application files
COPY server/ ./server/
COPY web/ ./web/

# Set ownership
RUN chown -R appuser:appuser /app

USER appuser

# Environment defaults (Railway dynamically provides PORT)
ENV PORT=8080
ENV HOST=0.0.0.0
ENV PYTHONUNBUFFERED=1

EXPOSE 8080

# Health check endpoint for Railway / container runtimes
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request, os; port = os.environ.get('PORT', '8080'); urllib.request.urlopen(f'http://127.0.0.1:{port}/signal/health')" || exit 1

# Run the signaling server and serve the PWA frontend
CMD ["python", "server/signaling.py", "--static", "web"]
