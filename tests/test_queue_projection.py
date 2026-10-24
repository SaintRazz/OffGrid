import pytest
from test_transfer_update import sim, facility, finish


def test_pickup_then_future_deposit_all(sim):
    reactor = facility(sim, 'bsfl-reactor')
    sim.game_state['house']['outputs']['kitchen_waste'] = 2
    sim.queue_house_pickup('kitchen_waste', 2)
    limits = sim.state()['transfer_limits']
    assert sim._player_inventory_amount('kitchen_waste') == 0
    assert limits['projected_inventory']['kitchen_waste'] == 2
    assert limits['facilities']['bsfl-reactor']['deposit']['kitchen_waste'] == 2
    task = sim.queue_facility_fill('bsfl-reactor', 'kitchen_waste', 'all')
    assert task['amount'] == 2
    with pytest.raises(ValueError):
        sim.queue_facility_fill('bsfl-reactor', 'kitchen_waste', 1)
    finish(sim)
    assert reactor['feedstock_mass'] == pytest.approx(2)
    assert sim._player_inventory_amount('kitchen_waste') == 0


@pytest.mark.parametrize('remaining', [0, 1])
def test_cancel_supply_reduces_or_cancels_deposit(sim, remaining):
    facility(sim, 'bsfl-reactor')
    sim._add_player_inventory('kitchen_waste', remaining)
    sim.game_state['house']['outputs']['kitchen_waste'] = 2
    pickup = sim.queue_house_pickup('kitchen_waste', 2)
    sim.queue_facility_fill('bsfl-reactor', 'kitchen_waste', 'all')
    sim.cancel_task(pickup['task_id'])
    queue = sim.game_state['player']['task_queue']
    assert len(queue) == (1 if remaining else 0)
    if remaining:
        assert queue[0]['amount'] == remaining
    assert any(e['type'] == 'task_adjusted' for e in sim.game_state['pending_events'])
    finish(sim)
    assert sim.game_state['facilities'][0]['feedstock_mass'] == remaining


def test_later_deposit_cannot_justify_overloaded_pickup(sim):
    sim._add_player_inventory('feed', 40)
    sim.game_state['house']['outputs']['kitchen_waste'] = 20
    with pytest.raises(ValueError):
        sim.queue_house_pickup('kitchen_waste', 20)
    assert sim.queue_house_pickup('kitchen_waste', 'all')['amount'] == 10


def test_cancel_earlier_deposit_reduces_later_pickup(sim):
    sim._add_player_inventory('feed', 45)
    drop = sim.queue_house_storage_transfer('feed', 'all', 'to_house')
    sim.game_state['house']['outputs']['kitchen_waste'] = 20
    sim.queue_house_pickup('kitchen_waste', 20)
    sim.cancel_task(drop['task_id'])
    assert sim.game_state['player']['task_queue'][0]['amount'] == 5
    assert sim.game_state['house']['outputs']['kitchen_waste'] == 15
    finish(sim)
    assert sim.carry_mass() == 50


def test_future_storage_pickup_and_dropoff(sim):
    sim._add_house_storage('feed', 10)
    sim.queue_house_storage_transfer('feed', 10, 'to_player')
    sim.queue_house_storage_transfer('feed', 'all', 'to_house')
    finish(sim)
    assert sim._house_storage_amount('feed') == 10
    assert sim._player_inventory_amount('feed') == 0


def test_bsfl_residue_stock_and_bucket_requirement(sim):
    reactor = facility(sim, 'bsfl-reactor', residue_mass=3)
    limits = sim.state()['transfer_limits']['facilities']['bsfl-reactor']
    assert limits['collect_stock']['active_compost'] == 3
    assert limits['collect']['active_compost'] == 0
    sim._add_player_inventory('bucket', 1)
    task = sim.queue_facility_collection('bsfl-reactor', 'active_compost', 'all', 'residue_mass')
    assert task['amount'] == 3
    assert sim.state()['transfer_limits']['facilities']['bsfl-reactor']['collect_stock']['active_compost'] == 0
    finish(sim)
    assert reactor['residue_mass'] == 0
    assert sim._player_inventory_amount('active_compost') == 3


def test_future_bucket_collection_and_compost_delivery(sim):
    reactor = facility(sim, 'bsfl-reactor', residue_mass=3)
    pile = facility(sim, 'compost-pile', column=8)
    sim._add_house_storage('bucket', 1)
    sim.queue_house_storage_transfer('bucket', 1, 'to_player')
    sim.queue_facility_collection('bsfl-reactor', 'active_compost', 'all', 'residue_mass')
    sim.queue_facility_fill('compost-pile', 'active_compost', 'all')
    finish(sim)
    assert reactor['residue_mass'] == 0
    assert pile['active_compost_mass'] > 2.9
    assert sim._player_inventory_amount('active_compost') == 0


def test_destination_reservations_cap_future_deliveries(sim):
    reactor = facility(sim, 'bsfl-reactor')
    capacity = sim._fill_spec(reactor, 'kitchen_waste')['capacity']
    reactor['feedstock_mass'] = capacity - 1
    sim.game_state['house']['outputs']['kitchen_waste'] = 3
    sim.queue_house_pickup('kitchen_waste', 3)
    assert sim.queue_facility_fill('bsfl-reactor', 'kitchen_waste', 'all')['amount'] == 1
    with pytest.raises(ValueError):
        sim.queue_facility_fill('bsfl-reactor', 'kitchen_waste', 1)
    assert sim.projected_player_inventory()['kitchen_waste'] == 2


def test_legacy_prepaid_delivery_remains_compatible(sim):
    reactor = facility(sim, 'bsfl-reactor')
    sim._add_player_inventory('kitchen_waste', 2)
    sim.queue_facility_fill('bsfl-reactor', 'kitchen_waste', 2)
    task = sim.game_state['player']['task_queue'][0]
    sim._consume_player_inventory('kitchen_waste', 2)
    task['reserved_cargo']['source'] = 'player'
    assert sim.projected_player_inventory()['kitchen_waste'] == 0
    finish(sim)
    assert reactor['feedstock_mass'] == 2


def test_reload_future_queue_and_projection_index(sim):
    from simulation import Simulation
    facility(sim, 'bsfl-reactor')
    sim.game_state['house']['outputs']['kitchen_waste'] = 2
    sim.queue_house_pickup('kitchen_waste', 2)
    sim.queue_facility_fill('bsfl-reactor', 'kitchen_waste', 'all')
    assert sim.projected_player_inventory(0).get('kitchen_waste', 0) == 0
    assert sim.projected_player_inventory(1)['kitchen_waste'] == 2
    sim.save()
    loaded = Simulation(sim.facilities_file, sim.resources_file, sim.household_profile_file, sim.game_state_file)
    finish(loaded)
    assert loaded.game_state['facilities'][0]['feedstock_mass'] == 2


def test_api_future_deposit_and_dependency_cancellation(sim):
    from app import app
    app.extensions['simulation'] = sim
    facility(sim, 'bsfl-reactor')
    sim.game_state['house']['outputs']['kitchen_waste'] = 2
    client = app.test_client()
    picked = client.post('/api/house/pickup', json={'resource_id': 'kitchen_waste', 'amount': 2})
    assert picked.status_code == 200
    response = client.post('/api/facilities/bsfl-reactor/fill', json={'resource_id': 'kitchen_waste', 'amount': 'all'})
    assert response.status_code == 200
    assert response.get_json()['state']['player']['task_queue'][-1]['amount'] == 2
    pickup_id = sim.game_state['player']['task_queue'][0]['task_id']
    response = client.post(f'/api/tasks/{pickup_id}/cancel')
    assert response.status_code == 200
    assert response.get_json()['state']['player']['task_queue'] == []
