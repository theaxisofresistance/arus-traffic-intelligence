"""Single-workspace forecasting service. All mutable operations are serialized by app.py."""
from pathlib import Path
from zipfile import ZipFile, BadZipFile
import io
import json
import os
import warnings
import numpy as np
from model import load_model

MAX_EXPANDED_BYTES = 180 * 1024 * 1024
SYNTHETIC_MAP_CENTER = (-6.2088, 106.8456)
JAKARTA_ROUTES = (
    ('Sudirman–Thamrin', ((-6.193101, 106.822932), (-6.201156, 106.823211),
                           (-6.210249, 106.821302), (-6.218101, 106.814415),
                           (-6.220987, 106.810756), (-6.226878, 106.802483))),
    ('Gatot Subroto', ((-6.229171, 106.796941), (-6.219047, 106.812739),
                        (-6.231964, 106.821051), (-6.240116, 106.832642),
                        (-6.243023, 106.842972))),
    ('Rasuna Said', ((-6.207019, 106.829964), (-6.218132, 106.831192),
                      (-6.224322, 106.834064), (-6.231895, 106.832714),
                      (-6.238032, 106.826652), (-6.240985, 106.836946))),
    ('S. Parman', ((-6.165998, 106.788995), (-6.177683, 106.795127),
                    (-6.193748, 106.797472), (-6.205528, 106.801940),
                    (-6.212429, 106.808078), (-6.218902, 106.799976))),
    ('Ahmad Yani', ((-6.193790, 106.889875), (-6.192335, 106.874046),
                     (-6.180772, 106.875665), (-6.175400, 106.876088),
                     (-6.166864, 106.878515), (-6.165851, 106.872951))),
    ('T.B. Simatupang', ((-6.288830, 106.780134), (-6.291773, 106.785864),
                          (-6.292172, 106.818433), (-6.302509, 106.839080),
                          (-6.304084, 106.850866), (-6.302300, 106.859052),
                          (-6.302701, 106.868120))),
    ('Daan Mogot', ((-6.153006, 106.703944), (-6.155513, 106.713820),
                     (-6.154784, 106.731152), (-6.155205, 106.747592),
                     (-6.158383, 106.761819), (-6.164818, 106.779181),
                     (-6.165998, 106.788995))),
    ('Gunung Sahari', ((-6.134990, 106.832045), (-6.145338, 106.834357),
                        (-6.157775, 106.837115), (-6.175042, 106.841462),
                        (-6.185971, 106.844855))),
)


def synthetic_sensor_position(index, count):
    """Return a stable point along an illustrative Jakarta road corridor."""
    route_index = index % len(JAKARTA_ROUTES)
    route_name, route_points = JAKARTA_ROUTES[route_index]
    step = index // len(JAKARTA_ROUTES)
    route_steps = max(2, int(np.ceil(count / len(JAKARTA_ROUTES))))
    points = np.asarray(route_points, dtype=np.float64)
    lengths = np.sqrt(np.square(np.diff(points, axis=0)).sum(axis=1))
    cumulative = np.concatenate(([0.0], np.cumsum(lengths)))
    target = cumulative[-1] * min(step / (route_steps - 1), 1.0)
    segment = min(int(np.searchsorted(cumulative, target, side='right') - 1), len(lengths) - 1)
    fraction = (target - cumulative[segment]) / lengths[segment] if lengths[segment] else 0.0
    latitude, longitude = points[segment] + fraction * (points[segment + 1] - points[segment])
    return round(float(latitude), 6), round(float(longitude), 6), route_name


def demo_data():
    rng = np.random.default_rng(42)
    t = np.arange(1152)[:, None]
    phase = np.linspace(-0.6, 0.6, 24)[None, :]
    flow = np.maximum(0, 145 + 65 * np.sin(t * 2 * np.pi / 288 - 0.8 + phase)
                      + 23 * np.sin(t * 4 * np.pi / 288 + phase) + rng.normal(0, 7, (1152, 24)))
    occupancy = np.clip(0.05 + flow / 1500 + rng.normal(0, .008, flow.shape), 0, 1)
    speed = np.clip(88 - flow / 5 + rng.normal(0, 2, flow.shape), 5, 100)
    return np.stack((flow, occupancy, speed), axis=-1).astype(np.float32)


def read_npz(path):
    try:
        with ZipFile(path) as archive:
            members = archive.infolist()
            if sum(x.file_size for x in members) > MAX_EXPANDED_BYTES:
                raise ValueError('Ukuran data setelah ekstraksi melebihi 180 MB.')
            if 'data.npy' not in archive.namelist():
                raise ValueError("File NPZ harus memiliki key 'data'.")
            # Inspect shape before numpy allocates from an untrusted NPY header.
            with archive.open('data.npy') as source:
                version = np.lib.format.read_magic(source)
                if version == (1, 0):
                    shape, _, dtype = np.lib.format.read_array_header_1_0(source)
                elif version == (2, 0):
                    shape, _, dtype = np.lib.format.read_array_header_2_0(source)
                else:
                    raise ValueError('Gunakan format NPY versi 1/2 di dalam NPZ.')
                if dtype.kind not in 'fiu' or len(shape) != 3 or shape[2] != 3:
                    raise ValueError('Data harus numerik dengan bentuk [waktu, sensor, 3].')
                if not 24 <= shape[0] <= 200000 or not 1 <= shape[1] <= 2000:
                    raise ValueError('Diperlukan 24–200.000 timestep dan 1–2.000 sensor.')
                if int(np.prod(shape, dtype=object)) * max(dtype.itemsize, 4) > MAX_EXPANDED_BYTES:
                    raise ValueError('Array terlalu besar; maksimum 180 MB setelah konversi.')
        with np.load(path, allow_pickle=False) as source:
            data = np.array(source['data'], dtype=np.float32, copy=True)
    except (OSError, BadZipFile, EOFError) as exc:
        raise ValueError('File NPZ rusak atau tidak dapat dibaca.') from exc
    if not np.isfinite(data[:, :, 0]).any():
        raise ValueError('Tidak ada target flow yang valid.')
    return data


def metrics(actual, predicted):
    mask = np.isfinite(actual)
    if not mask.any():
        return {'mae': None, 'rmse': None, 'wape': None, 'count': 0}
    a, p = actual[mask].astype(np.float64), predicted[mask].astype(np.float64)
    if not np.isfinite(p).all():
        raise ValueError('Prediksi tidak finite.')
    err, denominator = p - a, np.abs(a).sum()
    return {'mae': float(np.abs(err).mean()), 'rmse': float(np.sqrt(np.square(err).mean())),
            'wape': float(100 * np.abs(err).sum() / denominator) if denominator > 1e-12 else None,
            'count': int(mask.sum())}


def nullable(value):
    return float(value) if np.isfinite(value) else None


def series(values):
    return [nullable(v) for v in values]


class TrafficService:
    def __init__(self, folder):
        self.folder = Path(folder)
        self.folder.mkdir(parents=True, exist_ok=True)
        self.data = demo_data()
        self.source = 'demo'
        self.filename = 'Data sintetis · 24 sensor'
        self.interval, self.speed_unit, self.occupancy_unit = 5, 'km/h', 'fraction'
        self.model = None
        self.revision = 1
        self.cache = {}
        self.startup_notice = None
        self._restore()

    @property
    def input_steps(self):
        return self.model['input_steps'] if self.model else 12

    @property
    def max_horizon(self):
        return self.model['horizon'] if self.model else 12

    def _restore(self):
        meta_path = self.folder / 'active.json'
        if meta_path.exists():
            try:
                meta = json.loads(meta_path.read_text())
                data = read_npz(self.folder / 'dataset.npz') if meta['source'] == 'uploaded' else demo_data()
                model = load_model(self.folder / 'model.pt') if meta.get('model') else None
                if model:
                    self.validate_pair(data, model, meta['interval'])
                self.data, self.model = data, model
                self.source, self.filename = meta['source'], meta['filename']
                self.interval, self.speed_unit, self.occupancy_unit = meta['interval'], meta['speed_unit'], meta['occupancy_unit']
            except Exception:
                self.startup_notice = 'Konfigurasi tersimpan tidak dapat dimuat. Mode demo diaktifkan; unggah ulang pasangan data dan model.'

    def metadata(self):
        return {'source': self.source, 'filename': self.filename, 'interval': self.interval,
                'speed_unit': self.speed_unit, 'occupancy_unit': self.occupancy_unit, 'model': self.model is not None}

    def persist(self):
        temp = self.folder / 'active.tmp'
        temp.write_text(json.dumps(self.metadata()), encoding='utf-8')
        os.replace(temp, self.folder / 'active.json')
        self.revision += 1
        self.cache.clear()

    @staticmethod
    def validate_pair(data, model, interval):
        if data.shape[1] != model['nodes']:
            raise ValueError(f"Model memerlukan {model['nodes']} sensor; dataset memiliki {data.shape[1]}. Unggah dataset yang cocok dahulu.")
        if len(data) < model['input_steps']:
            raise ValueError('Riwayat lebih pendek dari kebutuhan model.')
        if interval != model['interval']:
            raise ValueError(f"Interval model {model['interval']} menit tidak cocok dengan dataset {interval} menit.")

    def set_data(self, path, filename, interval, speed_unit, occupancy_unit):
        data = read_npz(path)
        if self.model:
            self.validate_pair(data, self.model, interval)
        temp = self.folder / 'dataset.tmp'
        with temp.open('wb') as handle:
            np.savez_compressed(handle, data=data)
        os.replace(temp, self.folder / 'dataset.npz')
        self.data, self.source, self.filename = data, 'uploaded', filename
        self.interval, self.speed_unit, self.occupancy_unit = interval, speed_unit, occupancy_unit
        self.persist()

    def set_model(self, path):
        model = load_model(path)
        self.validate_pair(self.data, model, self.interval)
        os.replace(path, self.folder / 'model.pt')
        self.model = model
        self.persist()

    def reset(self):
        self.data, self.model = demo_data(), None
        self.source, self.filename = 'demo', 'Data sintetis · 24 sensor'
        self.interval, self.speed_unit, self.occupancy_unit = 5, 'km/h', 'fraction'
        self.startup_notice = None
        self.persist()

    def remove_model(self):
        self.model = None
        self.persist()

    def fill_history(self, batch):
        """Causal fill within each input only; no future target values are consulted."""
        values = batch.copy()
        if self.model:
            return np.where(np.isfinite(values), values, self.model['impute'][None, None])
        for b in range(len(values)):
            for f in range(3):
                last = np.zeros(values.shape[2], dtype=np.float32)
                for t in range(values.shape[1]):
                    row = values[b, t, :, f]
                    last = np.where(np.isfinite(row), row, last)
                    values[b, t, :, f] = last
        return values

    def predict(self, batch, horizon):
        if self.model:
            return self.model['predict'](batch)[:, :horizon]
        # Explicit baseline, never presented as trained STGNN.
        values = self.fill_history(batch)[:, :, :, 0]
        slope = (values[:, -1] - values[:, -4]) / 3
        step = np.arange(1, horizon + 1)
        damping = (1 - 0.82 ** step) / (1 - 0.82)
        return np.maximum(0, values[:, -1, None, :] + slope[:, None, :] * damping[None, :, None]).astype(np.float32)

    def analyze(self, horizon):
        key = (self.revision, horizon)
        if key in self.cache:
            return self.cache[key]
        length = self.input_steps
        latest = self.predict(self.data[-length:][None], horizon)[0]
        # Bounded exploratory backtest. No claim that this is an unseen test split.
        last_origin = len(self.data) - horizon
        origins = np.arange(max(length, last_origin - 63), last_origin + 1)
        if len(origins):
            batch = np.stack([self.data[t-length:t] for t in origins])
            actual = np.stack([self.data[t:t+horizon, :, 0] for t in origins])
            predicted = np.concatenate([self.predict(batch[i:i+16], horizon) for i in range(0, len(batch), 16)])
            last = self.fill_history(batch)[:, -1, :, 0]
            baseline = np.repeat(last[:, None], horizon, axis=1)
            score, base_score = metrics(actual, predicted), metrics(actual, baseline)
            by_horizon = [metrics(actual[:, h], predicted[:, h]) for h in range(horizon)]
            sensor_scores = [metrics(actual[:, :, n], predicted[:, :, n])['mae'] for n in range(self.data.shape[1])]
        else:
            score = base_score = {'mae': None, 'rmse': None, 'wape': None, 'count': 0}
            actual = predicted = np.empty((0, horizon, self.data.shape[1]))
            by_horizon = []
            sensor_scores = [None] * self.data.shape[1]
        result = {'forecast': latest, 'score': score, 'baseline_score': base_score,
                  'by_horizon': by_horizon, 'origins': origins, 'actual': actual,
                  'predicted': predicted, 'sensor_scores': sensor_scores}
        self.cache[key] = result
        return result

    def dashboard(self, sensor, horizon):
        result = self.analyze(horizon)
        last = self.data[-1]
        def mean_feature(f):
            valid = last[:, f][np.isfinite(last[:, f])]
            return nullable(valid.mean()) if len(valid) else None
        previous = self.data[-min(len(self.data), 13), :, 0]
        valid_previous, valid_current = previous[np.isfinite(previous)], last[:, 0][np.isfinite(last[:, 0])]
        change = None
        if len(valid_previous) and len(valid_current) and abs(valid_previous.mean()) > 1e-8:
            change = float(100 * (valid_current.mean() / valid_previous.mean() - 1))
        rows = []
        for n in range(self.data.shape[1]):
            latitude, longitude, road = synthetic_sensor_position(n, self.data.shape[1])
            rows.append({'id': n, 'name': f'Sensor {n:03d}', 'flow': nullable(last[n, 0]),
                         'speed': nullable(last[n, 2]), 'occupancy': nullable(last[n, 1]),
                         'valid': bool(np.isfinite(last[n]).all()),
                         'prediction': nullable(result['forecast'][-1, n]), 'mae': result['sensor_scores'][n],
                         'spark': series(self.data[-24::2, n, 0]),
                         'map_location': {'latitude': latitude, 'longitude': longitude,
                                          'road': road, 'synthetic': True}})
        score, base = result['score'], result['baseline_score']
        skill = 100 * (1 - score['mae'] / base['mae']) if score['mae'] is not None and base['mae'] and base['mae'] > 1e-9 else None
        history = self.data[-min(len(self.data), 48):, sensor, 0]
        return {
            'revision': self.revision, 'source': self.source, 'filename': self.filename,
            'synthetic': self.source == 'demo' or bool(self.model and self.model['demo']),
            'notice': self.startup_notice, 'engine': self.model['name'] if self.model else 'Tren teredam · baseline',
            'has_model': bool(self.model), 'model_demo': bool(self.model and self.model['demo']),
            'model_epoch': self.model['best_epoch'] if self.model else None,
            'interval': self.interval, 'input_steps': self.input_steps, 'max_horizon': self.max_horizon,
            'horizon': horizon, 'sensor': sensor, 'speed_unit': self.speed_unit, 'occupancy_unit': self.occupancy_unit,
            'steps': len(self.data), 'nodes': self.data.shape[1],
            'map_metadata': {
                'type': 'synthetic', 'region': 'Jakarta', 'center': list(SYNTHETIC_MAP_CENTER),
                'roads': [name for name, _ in JAKARTA_ROUTES],
                'notice': 'Marker mengikuti koridor jalan Jakarta secara ilustratif, bukan lokasi sensor sebenarnya.'
            },
            'summary': {'flow': mean_feature(0), 'speed': mean_feature(2), 'occupancy': mean_feature(1),
                        'valid_nodes': int(np.isfinite(last).all(axis=1).sum()), 'change': change},
            'history': [{'minute': (i - len(history) + 1) * self.interval, 'value': nullable(v)} for i, v in enumerate(history)],
            'forecast': [{'minute': (h + 1) * self.interval, 'value': nullable(v)} for h, v in enumerate(result['forecast'][:, sensor])],
            'evaluation': {'model': score, 'persistence': base, 'skill': skill, 'origins': len(result['origins']),
                           'by_horizon': result['by_horizon'],
                           'actual': series(result['actual'][:, 0, sensor]) if len(result['origins']) else [],
                           'predicted': series(result['predicted'][:, 0, sensor]) if len(result['origins']) else []},
            'sensors': rows,
        }
