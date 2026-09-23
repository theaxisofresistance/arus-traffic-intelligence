"""Checkpoint-compatible model from the revised main.ipynb; torch is optional for baseline operation."""
from types import SimpleNamespace
import numpy as np


def load_model(path):
    try:
        import torch
        from torch import nn
    except ImportError as exc:
        raise ValueError('PyTorch belum terpasang. Jalankan: pip install -r requirements-model.txt') from exc

    class SpatioTemporalGNN(nn.Module):
        def __init__(self, in_features, n_nodes, adjacency, config):
            super().__init__()
            self.n_nodes, self.horizon = n_nodes, config.output_steps
            self.target_feature = config.target_feature
            self.register_buffer('adj_norm', torch.as_tensor(adjacency, dtype=torch.float32))
            self.input_proj = nn.Linear(in_features, config.gcn_hidden)
            self.graph_layers = nn.ModuleList([nn.Linear(config.gcn_hidden, config.gcn_hidden) for _ in range(2)])
            self.norms = nn.ModuleList([nn.LayerNorm(config.gcn_hidden) for _ in range(2)])
            self.node_embedding = nn.Parameter(torch.empty(n_nodes, config.node_embedding_dim))
            self.dropout = nn.Dropout(config.dropout)
            self.gru = nn.GRU(config.gcn_hidden + in_features + config.node_embedding_dim,
                              config.gru_hidden, batch_first=True)
            self.head = nn.Linear(config.gru_hidden, config.output_steps)

        def forward(self, x):
            b, length, n, _ = x.shape
            h = torch.relu(self.input_proj(x))
            for linear, norm in zip(self.graph_layers, self.norms):
                h = norm(h + self.dropout(torch.relu(torch.matmul(self.adj_norm, linear(h)))))
            ids = self.node_embedding[None, None].expand(b, length, -1, -1)
            sequence = torch.cat([h, x, ids], dim=-1).permute(0, 2, 1, 3).reshape(b * n, length, -1)
            _, hidden = self.gru(sequence)
            correction = self.head(self.dropout(hidden[-1])).reshape(b, n, self.horizon).permute(0, 2, 1)
            return x[:, -1, :, self.target_feature].unsqueeze(1) + correction

    try:
        saved = torch.load(path, map_location='cpu', weights_only=True)
        config = saved['config']
        limits = {'input_steps': 288, 'output_steps': 96, 'gcn_hidden': 512,
                  'gru_hidden': 512, 'node_embedding_dim': 128}
        for key, upper in limits.items():
            value = config[key]
            if type(value) is not int or not 1 <= value <= upper:
                raise ValueError(f'Konfigurasi {key} tidak didukung.')
        n, f = saved['num_nodes'], saved['num_features']
        if type(n) is not int or not 1 <= n <= 2000 or f != 3 or config['target_feature'] != 0:
            raise ValueError('Checkpoint harus memprediksi flow dengan 3 fitur dan 1–2000 sensor.')
        if not 0 <= float(config['dropout']) < 1:
            raise ValueError('Dropout tidak valid.')
        interval = config.get('sample_minutes', 5)
        if type(interval) is not int or not 1 <= interval <= 60:
            raise ValueError('Interval checkpoint tidak valid.')
        if [str(x).lower() for x in saved['feature_names']] != ['flow', 'occupancy', 'speed']:
            raise ValueError('Urutan fitur checkpoint harus Flow, Occupancy, Speed.')
        arrays = {}
        for key, shape in {'adj_norm': (n, n), 'train_mean': (3,), 'train_std': (3,), 'impute_values': (n, 3)}.items():
            value = saved[key].detach().cpu().numpy()
            if value.shape != shape or not np.isfinite(value).all():
                raise ValueError(f'Bentuk/nilai {key} tidak valid.')
            arrays[key] = value.astype(np.float32)
        if (arrays['train_std'] <= 0).any():
            raise ValueError('Standar deviasi checkpoint harus positif.')
        if not np.isclose(float(saved['target_mean']), arrays['train_mean'][0]) or not np.isclose(float(saved['target_std']), arrays['train_std'][0]):
            raise ValueError('Statistik target tidak konsisten.')
        torch.set_num_threads(2)
        model = SpatioTemporalGNN(3, n, arrays['adj_norm'], SimpleNamespace(**config))
        model.load_state_dict(saved['model_state'], strict=True)
        for tensor in model.state_dict().values():
            if not torch.isfinite(tensor).all():
                raise ValueError('Bobot model mengandung NaN/inf.')
        model.eval()
    except (KeyError, TypeError, AttributeError, RuntimeError, OverflowError) as exc:
        raise ValueError('Format checkpoint tidak cocok dengan notebook revisi. Gunakan best_model.pt hasil bagian Simpan eksperimen.') from exc
    except Exception as exc:
        if isinstance(exc, ValueError):
            raise
        raise ValueError('Checkpoint tidak dapat dibaca. Gunakan file .pt dari notebook revisi.') from exc

    @torch.inference_mode()
    def predict(batch):
        batch = np.asarray(batch, dtype=np.float32)
        if batch.ndim != 4 or batch.shape[1:] != (config['input_steps'], n, 3):
            raise ValueError('Bentuk input tidak cocok dengan checkpoint.')
        batch = np.where(np.isfinite(batch), batch, arrays['impute_values'][None, None])
        normalized = np.ascontiguousarray((batch - arrays['train_mean']) / arrays['train_std'])
        result = model(torch.from_numpy(normalized)).numpy() * arrays['train_std'][0] + arrays['train_mean'][0]
        if not np.isfinite(result).all():
            raise ValueError('Model menghasilkan NaN/inf. Periksa checkpoint.')
        return result

    return {'predict': predict, 'nodes': n, 'input_steps': config['input_steps'],
            'horizon': config['output_steps'], 'interval': interval,
            'best_epoch': saved.get('best_epoch'),
            'validation_only': bool(config.get('use_reference_data', False)),
            'impute': arrays['impute_values'], 'name': 'STGNN · GCN + GRU'}
