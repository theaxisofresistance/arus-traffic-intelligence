import io
import re
import sys
import zipfile
from pathlib import Path
import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import create_app
from service import metrics, read_npz


@pytest.fixture
def app(tmp_path):
    return create_app({'TESTING': True, 'DATA_DIR': str(tmp_path)})


def client_with_token(app):
    client = app.test_client()
    response = client.get('/')
    token = re.search(r'name="csrf-token" content="([^"]+)"', response.text).group(1)
    return client, {'X-CSRF-Token': token}


def npz(data):
    buffer = io.BytesIO()
    np.savez_compressed(buffer, data=data)
    buffer.seek(0)
    return buffer


def upload(client, headers, data, **kwargs):
    return client.post('/api/data', headers=headers, data={
        'file': (npz(data), 'traffic.npz'), 'interval': '5',
        'speed_unit': 'raw', 'occupancy_unit': 'raw', **kwargs}, content_type='multipart/form-data')


def test_demo_forecast_and_csv(app):
    client, headers = client_with_token(app)
    response = client.get('/api/dashboard?sensor=3&horizon=6')
    assert response.status_code == 200
    data = response.json
    assert data['source'] == 'demo' and data['synthetic'] and not data['has_model']
    assert data['sensor'] == 3 and len(data['forecast']) == 6
    assert data['forecast'][-1]['minute'] == 30
    assert data['nodes'] == 24 and data['evaluation']['origins'] == 64
    assert data['map_metadata']['type'] == 'synthetic'
    assert data['map_metadata']['region'] == 'Jakarta'
    assert len(data['map_metadata']['roads']) == 8
    assert data['sensors'][0]['map_location']['synthetic'] is True
    assert data['sensors'][0]['map_location']['road'] == 'Sudirman–Thamrin'
    assert -90 <= data['sensors'][0]['map_location']['latitude'] <= 90
    assert -180 <= data['sensors'][0]['map_location']['longitude'] <= 180
    assert data['evaluation']['model']['count'] == 64*6*24
    csv = client.get('/api/forecast.csv?sensor=3&horizon=6')
    assert csv.status_code == 200 and 'attachment' in csv.headers['Content-Disposition']
    assert 'minutes_ahead' in csv.text and 'Tren teredam' in csv.text
    assert len(csv.text.strip().splitlines()) == 7
    assert client.get('/api/health').json['status'] == 'ok'
    assert "script-src 'self'" in response.headers['Content-Security-Policy']
    assert 'tile.openstreetmap.org' in response.headers['Content-Security-Policy']
    page = client.get('/')
    assert 'data-panel="peta"' in page.text and 'Lokasi sintetis' in page.text
    assert 'id="prediction-road"' in page.text and 'Koridor ilustratif' in page.text
    assert client.get('/static/vendor/leaflet/leaflet.js').status_code == 200


@pytest.mark.parametrize('query', ['sensor=-1', 'sensor=24', 'sensor=x', 'horizon=0', 'horizon=13', 'horizon=1.5'])
def test_invalid_query(app, query):
    response = app.test_client().get('/api/dashboard?' + query)
    assert response.status_code == 400 and 'error' in response.json


def test_csrf(app):
    client, headers = client_with_token(app)
    assert client.post('/api/reset').status_code == 403
    assert client.post('/api/reset', headers={'X-CSRF-Token': 'wrong'}).status_code == 403
    assert client.post('/api/reset', headers=headers).status_code == 200


def test_upload_missing_values_restart_and_reset(app):
    client, headers = client_with_token(app)
    data = np.ones((70, 4, 3), np.float32) * 10
    data[-1, 2, 0] = np.nan
    data[-10, 1, 0] = np.inf
    assert upload(client, headers, data).status_code == 200
    result = client.get('/api/dashboard?sensor=2&horizon=1').json
    assert result['source'] == 'uploaded' and not result['synthetic']
    assert result['sensors'][2]['flow'] is None and result['sensors'][2]['valid'] is False
    assert result['forecast'][0]['value'] is not None
    assert result['evaluation']['model']['count'] < result['evaluation']['origins'] * 4
    restored = create_app({'TESTING': True, 'DATA_DIR': app.config['DATA_DIR']})
    assert restored.test_client().get('/api/dashboard').json['nodes'] == 4
    assert client.post('/api/reset', headers=headers).status_code == 200
    assert client.get('/api/dashboard').json['nodes'] == 24


@pytest.mark.parametrize('data', [np.ones((25,3)), np.ones((25,2,2)), np.ones((5,2,3)), np.full((25,2,3), np.nan), np.ones((25,2,3), dtype=object)])
def test_bad_dataset_does_not_replace_active(app, data):
    client, headers = client_with_token(app)
    assert upload(client, headers, data).status_code == 400
    assert client.get('/api/dashboard').json['source'] == 'demo'


def test_corrupt_file_and_request_size(app):
    client, headers = client_with_token(app)
    response=client.post('/api/data', headers=headers, data={'file': (io.BytesIO(b'broken'), 'bad.npz')})
    assert response.status_code == 400
    app.config['MAX_CONTENT_LENGTH'] = 512
    response=client.post('/api/data', headers=headers, data={'file': (io.BytesIO(b'x'*1024), 'big.npz')})
    assert response.status_code == 413


def test_npy_header_rejects_huge_shape_before_allocation(tmp_path):
    buffer = io.BytesIO()
    np.lib.format.write_array_header_1_0(buffer, {'descr':'<f4','fortran_order':False,'shape':(100000,2000,3)})
    path=tmp_path/'malformed.npz'
    with zipfile.ZipFile(path,'w') as archive:
        archive.writestr('data.npy', buffer.getvalue())
    with pytest.raises(ValueError, match='terlalu besar'):
        read_npz(path)


def test_metrics_masking():
    result = metrics(np.array([0.,2.,np.nan]), np.array([1.,4.,999.]))
    assert result['mae'] == 1.5 and result['wape'] == 150 and result['count'] == 2
    assert np.isclose(result['rmse'],np.sqrt(2.5))
    assert metrics(np.zeros(3),np.ones(3))['wape'] is None
    assert metrics(np.full(3,np.nan),np.ones(3))['mae'] is None


def make_checkpoint(path, nodes=4):
    torch=pytest.importorskip('torch')
    # Names/shapes mirror the exact notebook's exported tensors. Zero head = persistence.
    g,r,e=8,12,4
    from torch import nn
    parts = {'input_proj':nn.Linear(3,g), 'graph_layers.0':nn.Linear(g,g),
             'graph_layers.1':nn.Linear(g,g), 'norms.0':nn.LayerNorm(g),
             'norms.1':nn.LayerNorm(g), 'gru':nn.GRU(g+3+e,r,batch_first=True), 'head':nn.Linear(r,3)}
    nn.init.zeros_(parts['head'].weight);nn.init.zeros_(parts['head'].bias)
    state={'adj_norm':torch.eye(nodes),'node_embedding':torch.zeros(nodes,e)}
    for name,module in parts.items():
        state.update({f'{name}.{k}':v for k,v in module.state_dict().items()})
    saved={'config':{'input_steps':12,'output_steps':3,'target_feature':0,'gcn_hidden':g,'gru_hidden':r,
                     'node_embedding_dim':e,'dropout':.1,'sample_minutes':5,'use_demo_data':True},
           'num_nodes':nodes,'num_features':3,'feature_names':['Flow','Occupancy','Speed'],
           'train_mean':torch.tensor([10.,10.,10.]),'train_std':torch.ones(3),
           'target_mean':10.,'target_std':1.,'impute_values':torch.full((nodes,3),10.),
           'adj_norm':torch.eye(nodes),'model_state':state,'best_epoch':2}
    torch.save(saved,path)


def test_model_integration_and_mismatch(app,tmp_path):
    client, headers = client_with_token(app)
    path=tmp_path/'checkpoint.pt'
    make_checkpoint(path)
    response=client.post('/api/model',headers=headers,data={'file':(io.BytesIO(path.read_bytes()),'best_model.pt')})
    assert response.status_code == 400 and '4 sensor' in response.json['error']
    data=np.ones((80,4,3),np.float32)*10
    assert upload(client,headers,data).status_code == 200
    response=client.post('/api/model',headers=headers,data={'file':(io.BytesIO(path.read_bytes()),'best_model.pt')})
    assert response.status_code == 200, response.json
    result=client.get('/api/dashboard?sensor=2&horizon=3').json
    assert result['has_model'] and result['model_demo'] and result['synthetic']
    assert all(x['value'] == 10. for x in result['forecast'])
    assert result['evaluation']['model']['mae'] == 0
    assert upload(client,headers,data,interval='10').status_code == 400
    assert upload(client,headers,np.ones((80,2,3),np.float32)).status_code == 400
    restored=create_app({'TESTING':True,'DATA_DIR':app.config['DATA_DIR']})
    assert restored.test_client().get('/api/dashboard').json['has_model']
    assert client.delete('/api/model',headers=headers).status_code == 200
    assert not client.get('/api/dashboard').json['has_model']
