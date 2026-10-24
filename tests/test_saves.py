import json
from pathlib import Path
import pytest
import app as server


@pytest.fixture
def client(tmp_path, monkeypatch):
    root = Path(server.__file__).parent
    for filename in ('NewGame.json', 'crop.json'):
        (tmp_path / filename).write_bytes((root / filename).read_bytes())
    monkeypatch.setattr(server, 'BASE_DIR', tmp_path)
    monkeypatch.setattr(server, 'NEW_GAME_FILE', tmp_path / 'NewGame.json')
    monkeypatch.setattr(server, 'ACTIVE_GAME_FILE', tmp_path / 'ActiveGame.json')
    monkeypatch.setattr(server, 'SAVES_DIR', tmp_path / 'saves')
    monkeypatch.setattr(server, 'CURRENT_GAME_FILE', None)
    monkeypatch.setattr(server, 'CURRENT_GAME_NAME', None)
    monkeypatch.setattr(server, 'CURRENT_SAVE_ID', None)
    monkeypatch.setitem(server.app.extensions, 'simulation', None)
    return server.app.test_client()


def new_game(client):
    response = client.post('/api/new-game')
    assert response.status_code == 200
    return response.get_json()


def test_new_game_requires_named_first_save(client):
    assert client.post('/api/save-game').status_code == 409
    initial = new_game(client)
    assert initial['save_id'] is None
    assert initial['state']['current_time']
    assert client.post('/api/save-game').get_json()['name_required']
    assert client.get('/api/saves').get_json()['saves'] == []


def test_named_save_overwrite_and_save_as(client):
    new_game(client)
    saved = client.post('/api/save-game', json={'name': '  First Garden  '}).get_json()
    assert saved['game_name'] == 'First Garden'
    original_id = saved['save_id']
    original_file = server.BASE_DIR / original_id
    before = json.loads(original_file.read_text())
    simulation = server.get_simulation()
    simulation.advance_minutes(5)
    assert json.loads(original_file.read_text()) == before
    overwrite = client.post('/api/save-game').get_json()
    assert overwrite['save_id'] == original_id
    assert json.loads(original_file.read_text())['time'] == simulation.game_state['time']
    copied = client.post('/api/save-game', json={'name': 'First Garden'}).get_json()
    assert copied['save_id'] != original_id
    assert len(client.get('/api/saves').get_json()['saves']) == 2
    assert client.get('/api/session').get_json()['save_id'] == copied['save_id']


def test_load_uses_active_copy_and_restores_queue(client):
    new_game(client)
    sim = server.get_simulation()
    sim.game_state['house']['outputs']['kitchen_waste'] = 2
    sim.queue_house_pickup('kitchen_waste', 2)
    saved = client.post('/api/save-game', json={'name': 'Queued work'}).get_json()
    path = server.BASE_DIR / saved['save_id']
    snapshot = path.read_bytes()
    new_game(client)
    result = client.post('/api/load-game', json={'save_id': saved['save_id']})
    assert result.status_code == 200
    assert result.get_json()['game_name'] == 'Queued work'
    assert len(result.get_json()['state']['player']['task_queue']) == 1
    assert server.get_simulation().game_state_file == server.ACTIVE_GAME_FILE
    server.get_simulation().advance_minutes(10)
    assert path.read_bytes() == snapshot
    assert client.post('/api/save-game').get_json()['save_id'] == saved['save_id']
    assert path.read_bytes() != snapshot


@pytest.mark.parametrize('name', ['', '   ', 23, [], 'x' * 81, 'bad\nname'])
def test_invalid_name_rejected(client, name):
    new_game(client)
    assert client.post('/api/save-game', json={'name': name}).status_code == 400
    assert not server.SAVES_DIR.exists()


def test_name_cannot_escape_save_directory(client):
    new_game(client)
    response = client.post('/api/save-game', json={'name': '../../A nice homestead'})
    assert response.status_code == 200
    saved = response.get_json()
    assert (server.BASE_DIR / saved['save_id']).parent == server.SAVES_DIR
    assert saved['game_name'] == '../../A nice homestead'
    assert client.post('/api/load-game', json={'save_id': '../../NewGame.json'}).status_code == 400


def test_list_filters_definitions_corrupt_files_and_supports_legacy(client):
    (server.BASE_DIR / 'crop.json').write_text('{"crops": {}}')
    (server.BASE_DIR / 'broken.json').write_text('{broken')
    legacy = server.BASE_DIR / 'Legacy.json'
    legacy.write_bytes(server.NEW_GAME_FILE.read_bytes())
    saves = client.get('/api/saves').get_json()['saves']
    assert [s['id'] for s in saves] == ['Legacy.json']
    assert saves[0]['saved_at']


def test_failed_atomic_save_preserves_previous_file(client, monkeypatch):
    new_game(client)
    saved = client.post('/api/save-game', json={'name': 'Safe snapshot'}).get_json()
    path = server.BASE_DIR / saved['save_id']
    previous = path.read_bytes()
    def fail(*args):
        raise OSError('Disk unavailable')
    monkeypatch.setattr(server.os, 'replace', fail)
    assert client.post('/api/save-game').status_code == 400
    assert path.read_bytes() == previous
    assert not list(server.SAVES_DIR.glob('*.tmp'))


def test_save_rejects_non_object_payload(client):
    new_game(client)
    assert client.post('/api/save-game', json=['bad']).status_code == 400


def test_launch_page_exposes_choice_and_named_save_controls(client):
    page = client.get('/').get_data(as_text=True)
    for control in ('new-game-button', 'load-game-button', 'save-game-button', 'save-as-button', 'save-name-input', 'open-new-game-button', 'open-load-game-button', 'return-to-game-button'):
        assert f'id="{control}"' in page
    assert 'New Game (Default)' in page
