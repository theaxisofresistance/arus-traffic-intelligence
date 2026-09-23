"""ARUS: Flask dashboard for the revised traffic forecasting notebook."""
import csv
import io
import json
import math
import os
import re
import secrets
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path
from flask import Flask, jsonify, render_template, request, send_file, session
from werkzeug.exceptions import HTTPException
from werkzeug.utils import secure_filename
from service import TrafficService


IOT_MAX_READINGS = 500
IOT_DEVICE_PATTERN = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$')


def create_app(test_config=None):
    app = Flask(__name__, instance_relative_config=True)
    default_data_dir = '/tmp/arus_flask' if os.environ.get('VERCEL') else app.instance_path
    app.config.update(MAX_CONTENT_LENGTH=80 * 1024 * 1024, SESSION_COOKIE_HTTPONLY=True,
                      SESSION_COOKIE_SAMESITE='Strict', JSON_SORT_KEYS=False,
                      DATA_DIR=os.environ.get('ARUS_DATA_DIR', default_data_dir))
    if test_config:
        app.config.update(test_config)
    folder = Path(app.config['DATA_DIR'])
    folder.mkdir(parents=True, exist_ok=True)
    secret_path = folder / 'session.key'
    if not secret_path.exists():
        secret_path.write_text(secrets.token_hex(32))
        try:
            secret_path.chmod(0o600)
        except OSError:
            pass
    app.config['SECRET_KEY'] = os.environ.get('ARUS_SECRET_KEY') or secret_path.read_text().strip()
    service = TrafficService(folder)
    lock = threading.RLock()
    app.extensions['traffic'] = service
    iot_path = folder / 'iot_readings.json'

    def load_iot_readings():
        try:
            value = json.loads(iot_path.read_text(encoding='utf-8'))
            return value[-IOT_MAX_READINGS:] if isinstance(value, list) else []
        except (OSError, ValueError):
            return []

    iot_readings = load_iot_readings()

    def persist_iot_readings():
        temporary = folder / 'iot_readings.tmp'
        temporary.write_text(json.dumps(iot_readings, ensure_ascii=False), encoding='utf-8')
        os.replace(temporary, iot_path)

    @app.before_request
    def protect_changes():
        if request.method in ('POST', 'DELETE', 'PUT', 'PATCH'):
            if request.path == '/api/iot/readings':
                return None
            expected = session.get('csrf')
            supplied = request.headers.get('X-CSRF-Token', '')
            if not expected or not secrets.compare_digest(expected, supplied):
                return jsonify(error='Sesi kedaluwarsa. Muat ulang halaman dan coba lagi.'), 403

    @app.after_request
    def headers(response):
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Referrer-Policy'] = 'same-origin'
        response.headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://*.tile.openstreetmap.org; font-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'"
        if request.path.startswith('/api/'):
            response.headers['Cache-Control'] = 'no-store'
        return response

    @app.errorhandler(ValueError)
    def invalid(error):
        return jsonify(error=str(error)), 400

    @app.errorhandler(HTTPException)
    def http_error(error):
        message = 'Berkas terlalu besar. Maksimum unggahan 80 MB.' if error.code == 413 else error.description
        return jsonify(error=message), error.code

    @app.errorhandler(Exception)
    def unexpected(error):
        app.logger.exception('Request failed')
        return jsonify(error='Permintaan gagal diproses. Periksa log server lalu coba kembali.'), 500

    @app.get('/')
    def index():
        session.setdefault('csrf', secrets.token_hex(24))
        return render_template('index.html', csrf=session['csrf'])

    def selection():
        try:
            sensor = int(request.args.get('sensor', 0))
            horizon = int(request.args.get('horizon', min(12, service.max_horizon)))
        except (TypeError, ValueError) as exc:
            raise ValueError('Sensor dan horizon harus bilangan bulat.') from exc
        if not 0 <= sensor < service.data.shape[1]:
            raise ValueError('Sensor tidak ditemukan pada dataset aktif.')
        if not 1 <= horizon <= service.max_horizon:
            raise ValueError(f'Horizon harus 1–{service.max_horizon} langkah.')
        return sensor, horizon

    @app.get('/api/dashboard')
    def dashboard():
        with lock:
            return jsonify(service.dashboard(*selection()))

    @app.get('/api/health')
    def health():
        return jsonify(status='ok', application='ARUS')

    @app.route('/api/iot/readings', methods=['GET', 'POST'])
    def iot():
        if request.method == 'POST':
            if request.content_length and request.content_length > 16 * 1024:
                return jsonify(error='Payload IoT maksimum 16 KB.'), 413
            if not request.is_json:
                raise ValueError('Gunakan Content-Type application/json.')
            payload = request.get_json(silent=True)
            if not isinstance(payload, dict):
                raise ValueError('Body harus berupa objek JSON.')
            device_id = str(payload.get('device_id', '')).strip()
            if not IOT_DEVICE_PATTERN.fullmatch(device_id):
                raise ValueError('device_id wajib 1–64 karakter: huruf, angka, titik, garis, titik dua, atau underscore.')
            values = {}
            for field in ('flow', 'occupancy', 'speed'):
                value = payload.get(field)
                if isinstance(value, bool):
                    raise ValueError(f'{field} harus berupa angka.')
                try:
                    value = float(value)
                except (TypeError, ValueError) as exc:
                    raise ValueError(f'{field} harus berupa angka.') from exc
                if not math.isfinite(value):
                    raise ValueError(f'{field} harus berupa angka finite.')
                if value < 0:
                    raise ValueError(f'{field} tidak boleh negatif.')
                values[field] = value
            latitude, longitude = payload.get('latitude'), payload.get('longitude')
            if (latitude is None) != (longitude is None):
                raise ValueError('latitude dan longitude harus dikirim bersamaan.')
            if latitude is not None:
                try:
                    latitude, longitude = float(latitude), float(longitude)
                except (TypeError, ValueError) as exc:
                    raise ValueError('latitude dan longitude harus berupa angka.') from exc
                if not math.isfinite(latitude) or not math.isfinite(longitude):
                    raise ValueError('Koordinat GPS harus berupa angka finite.')
                if not -90 <= latitude <= 90 or not -180 <= longitude <= 180:
                    raise ValueError('Koordinat GPS berada di luar rentang yang valid.')
            timestamp = payload.get('timestamp')
            if timestamp is None:
                observed = datetime.now(timezone.utc)
            else:
                try:
                    observed = datetime.fromisoformat(str(timestamp).replace('Z', '+00:00'))
                    if observed.tzinfo is None:
                        observed = observed.replace(tzinfo=timezone.utc)
                    observed = observed.astimezone(timezone.utc)
                except ValueError as exc:
                    raise ValueError('timestamp harus berformat ISO 8601.') from exc
            reading = {
                'id': secrets.token_hex(8), 'device_id': device_id,
                'timestamp': observed.isoformat().replace('+00:00', 'Z'), **values,
                'received_at': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
            }
            if latitude is not None:
                reading.update(latitude=latitude, longitude=longitude)
            with lock:
                iot_readings.append(reading)
                del iot_readings[:-IOT_MAX_READINGS]
                persist_iot_readings()
            return jsonify(message='Data sensor berhasil diterima.', reading=reading), 201

        try:
            limit = int(request.args.get('limit', 50))
        except (TypeError, ValueError) as exc:
            raise ValueError('limit harus berupa bilangan bulat.') from exc
        if not 1 <= limit <= 200:
            raise ValueError('limit harus antara 1 dan 200.')
        with lock:
            recent = list(reversed(iot_readings[-limit:]))
            latest = {}
            for reading in reversed(iot_readings):
                latest.setdefault(reading['device_id'], reading)
        return jsonify(readings=recent, latest=list(latest.values()), total=len(iot_readings))

    @app.get('/api/forecast.csv')
    def export_csv():
        with lock:
            sensor, horizon = selection()
            result = service.dashboard(sensor, horizon)
        stream = io.StringIO(newline='')
        writer = csv.writer(stream)
        writer.writerow(['sensor_index', 'minutes_ahead', 'predicted_flow', 'engine', 'source', 'revision'])
        for row in result['forecast']:
            writer.writerow([sensor, row['minute'], row['value'], result['engine'], result['source'], result['revision']])
        return send_file(io.BytesIO(stream.getvalue().encode('utf-8-sig')), mimetype='text/csv',
                         as_attachment=True, download_name=f'arus_forecast_sensor_{sensor:03d}.csv')

    def upload_path(extension):
        uploaded = request.files.get('file')
        if uploaded is None or not uploaded.filename:
            raise ValueError('Pilih berkas terlebih dahulu.')
        name = secure_filename(uploaded.filename) or f'upload{extension}'
        if Path(name).suffix.lower() != extension:
            raise ValueError(f'Gunakan berkas {extension}.')
        handle, path = tempfile.mkstemp(suffix=extension, dir=folder)
        os.close(handle)
        try:
            uploaded.save(path)
        except Exception:
            Path(path).unlink(missing_ok=True)
            raise
        return Path(path), name

    @app.post('/api/data')
    def upload_data():
        try:
            interval = int(request.form.get('interval', 5))
        except ValueError as exc:
            raise ValueError('Interval harus bilangan bulat.') from exc
        if not 1 <= interval <= 60:
            raise ValueError('Interval harus 1–60 menit.')
        speed_unit = request.form.get('speed_unit', 'raw')
        occupancy_unit = request.form.get('occupancy_unit', 'raw')
        if speed_unit not in ('raw', 'km/h', 'mph') or occupancy_unit not in ('raw', 'fraction', 'percent'):
            raise ValueError('Satuan data tidak valid.')
        path, name = upload_path('.npz')
        try:
            with lock:
                service.set_data(path, name, interval, speed_unit, occupancy_unit)
        finally:
            path.unlink(missing_ok=True)
        return jsonify(message='Dataset berhasil diaktifkan.')

    @app.post('/api/model')
    def upload_model():
        path, _ = upload_path('.pt')
        try:
            with lock:
                service.set_model(path)
        finally:
            path.unlink(missing_ok=True)
        return jsonify(message='Checkpoint STGNN berhasil diaktifkan.')

    @app.delete('/api/model')
    def remove_model():
        with lock:
            service.remove_model()
        return jsonify(message='Baseline aktif. Dataset tetap tersedia.')

    @app.post('/api/reset')
    def reset_workspace():
        with lock:
            service.reset()
        return jsonify(message='Konfigurasi default kembali aktif.')

    @app.get('/api/reference.npz')
    def reference_dataset():
        from service import seed_data
        out = io.BytesIO()
        import numpy as np
        np.savez_compressed(out, data=seed_data())
        out.seek(0)
        return send_file(out, as_attachment=True, download_name='arus_reference.npz', mimetype='application/octet-stream')

    return app


app = create_app()


if __name__ == '__main__':
    create_app().run(host=os.environ.get('HOST', '127.0.0.1'),
                     port=int(os.environ.get('PORT', 5001)), debug=False)
