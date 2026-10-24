import json
from pathlib import Path
import pytest
from simulation import Simulation

ROOT = Path(__file__).resolve().parents[1]

@pytest.fixture
def sim(tmp_path):
    save = tmp_path / 'game.json'
    save.write_text((ROOT / 'NewGame.json').read_text())
    return Simulation(ROOT/'facilities.json', ROOT/'resources.json', ROOT/'HouseholdProfile.json', save)

def facility(sim, kind, **values):
    item = {'instance_id': kind, 'facility_id': kind, 'column': 2, 'row': 2, **values}
    sim._normalize_instance(item)
    sim.game_state['facilities'].append(item)
    return item

def finish(sim):
    sim.advance_minutes(30)

@pytest.mark.parametrize('amount', [11, -1, float('nan'), float('inf')])
def test_pickup_rejects_invalid_or_excess(sim, amount):
    sim.game_state['house']['outputs']['kitchen_waste'] = 10
    with pytest.raises(ValueError): sim.queue_house_pickup('kitchen_waste', amount)
    assert not sim.game_state['player']['task_queue']

def test_pickup_all_reservations_and_cancellation(sim):
    sim.game_state['house']['outputs']['kitchen_waste'] = 90
    a = sim.queue_house_pickup('kitchen_waste', 30)
    b = sim.queue_house_pickup('kitchen_waste', 'all')
    assert b['amount'] == 20
    assert sim.carry_mass(True) == 50
    with pytest.raises(ValueError): sim.queue_house_pickup('kitchen_waste', 1)
    sim.cancel_task(a['task_id'])
    assert sim.carry_mass(True) == 20
    assert sim.game_state['house']['outputs']['kitchen_waste'] == 70
    finish(sim)
    assert sim._player_inventory_amount('kitchen_waste') == 20

def test_source_all(sim):
    sim.game_state['house']['outputs']['kitchen_waste'] = 3
    assert sim.queue_house_pickup('kitchen_waste', 'all')['amount'] == 3
    with pytest.raises(ValueError): sim.queue_house_pickup('kitchen_waste', 1)

def test_deposit_all_and_reserved_delivery_mass(sim):
    sim._add_player_inventory('feed', 10)
    with pytest.raises(ValueError): sim.queue_house_storage_transfer('feed', 11, 'to_house')
    t = sim.queue_house_storage_transfer('feed', 'all', 'to_house')
    assert t['amount'] == 10
    assert sim.carry_mass(True) == 10
    with pytest.raises(ValueError): sim.queue_house_storage_transfer('feed', 1, 'to_house')
    sim.cancel_task(t['task_id'])
    assert sim._player_inventory_amount('feed') == 10

@pytest.mark.parametrize('extra,expected', [(0,5), (10,38/8.34)])
def test_water_bucket_volume_mass_and_completion(sim, extra, expected):
    barrel = facility(sim, 'rain-barrel', current_fill=20)
    with pytest.raises(ValueError): sim.queue_facility_collection('rain-barrel','non_potable_water',1,'current_fill')
    sim._add_player_inventory('bucket',1)
    sim._add_player_inventory('feed',extra)
    t = sim.queue_facility_collection('rain-barrel','non_potable_water','all','current_fill')
    assert t['amount'] == pytest.approx(expected)
    with pytest.raises(ValueError): sim.queue_facility_collection('rain-barrel','non_potable_water',1,'current_fill')
    finish(sim)
    assert barrel['current_fill'] == pytest.approx(20-expected)
    assert sim._player_inventory_amount('non_potable_water') == pytest.approx(expected)
    assert sim.carry_mass() <= 50.000001
    with pytest.raises(ValueError): sim.queue_house_storage_transfer('bucket',1,'to_house')

def test_facility_collection_reservation_and_source(sim):
    coop=facility(sim,'chicken-coop',stored_outputs={'eggs':8})
    sim.queue_facility_collection('chicken-coop','eggs',6)
    with pytest.raises(ValueError): sim.queue_facility_collection('chicken-coop','eggs',3)
    assert sim.queue_facility_collection('chicken-coop','eggs','all')['amount']==2
    finish(sim)
    assert coop['stored_outputs']['eggs']==0
    assert sim._player_inventory_amount('eggs')==8

def test_facility_deposit_capacity(sim):
    coop=facility(sim,'chicken-coop',current_fill=0)
    sim._add_player_inventory('chicken',3)
    t=sim.queue_facility_fill('chicken-coop','chicken','all')
    assert t['amount']==3
    with pytest.raises(ValueError): sim.queue_facility_fill('chicken-coop','chicken',1)

@pytest.mark.parametrize('kind', ['rain-barrel','chicken-coop','compost-pile'])
def test_adjacent_facility(sim,kind):
    obj=facility(sim,kind)
    target=sim._nearest_adjacent_tile(obj)
    assert not sim._point_blocked(target['column'],target['row'])
    c,r=target['column'],target['row']; x,y=obj['column'],obj['row']
    assert (c in (x-1,x+obj['width']) and y<=r<y+obj['height']) or (r in (y-1,y+obj['height']) and x<=c<x+obj['width'])

def test_house_adjacent(sim):
    sim.game_state['house']['outputs']['kitchen_waste']=1
    task=sim.queue_house_pickup('kitchen_waste',1)
    assert not sim._point_blocked(**task['target'])
    sim._add_player_inventory('feed',1)
    task=sim.queue_house_storage_transfer('feed',1,'to_house')
    assert not sim._point_blocked(**task['target'])

@pytest.mark.parametrize('kitchen,carbon,state,needed',[(0,2,'carbon-rich',0),(10,1,'carbon-poor',4),(10,5,'balanced',0),(0,0,'empty',0),(10,7,'carbon-rich',0)])
def test_compost_balance(sim,kitchen,carbon,state,needed):
    result=sim.compost_balance({'unbalanced_kitchen_waste':kitchen,'available_carbon_material':carbon})
    assert result['state']==state
    assert result['needed']==needed

@pytest.mark.parametrize('birds,tiles',[(2,100),(10,100),(10,10),(10,0)])
def test_scat_property_flow(sim,birds,tiles):
    facility(sim,'chicken-coop',current_fill=birds)
    sim._active_default_tile_count=lambda:tiles
    before=sim.game_state['inventories'].get('scat',0)
    result=sim._process_default_tile()
    expected=max(0,birds*.125/24-tiles*.005/24)
    assert sim.game_state['inventories']['scat']-before==pytest.approx(expected)
    assert result['potential_scat_assimilation_lb']==pytest.approx(tiles*.005/24,abs=1e-6)

def test_forage_caps_eggs_grocery_and_local_bsfl(sim):
    coop=facility(sim,'chicken-coop',current_fill=2,feed_mass=20)
    for _ in range(10): sim.advance_hour()
    assert coop['stored_outputs'].get('eggs',0)==0
    assert 0<coop['production_remainders']['eggs']<1
    for _ in range(20): sim.advance_hour()
    for rid in ('green_forage','insect_forage'):
        rate=sim.facility_definitions['grass-tile']['outputs'][rid]['rate_per_day']
        assert 0<=sim.game_state['yard_resources'][rid]<=rate*sim._active_default_tile_count()*3
    assert coop['stored_outputs']['eggs']>=1
    sim.queue_facility_collection('chicken-coop','eggs',1)
    finish(sim)
    sim.queue_house_storage_transfer('eggs','all','to_house')
    finish(sim)
    assert sim.game_state['household']['grocery_credit_usd'] + sim.game_state['household']['cumulative_grocery_savings_usd'] == pytest.approx(.2)
    baseline=sim.household_hourly_baseline()
    sim.advance_hour()
    assert sim.game_state['household']['cumulative_grocery_savings_usd']>=.2
    assert sim.household_hourly_baseline()==baseline
    reactor=facility(sim,'bsfl-reactor',larval_biomass=5,feedstock_mass=20)
    sim._process_bsfl_reactor(reactor,sim.facility_definitions['bsfl-reactor'])
    assert sim.game_state['inventories'].get('insect_forage',0)==0

def test_bulk_and_water_share_bucket_volume(sim):
    pile=facility(sim,'compost-pile',mature_compost_mass=100)
    sim._add_player_inventory('bucket',1)
    task=sim.queue_facility_collection('compost-pile','compost','all','mature_compost_mass')
    assert task['amount']==30  # six lb/gal, five-gallon bucket
    assert sim.resource_volume('compost',30)==5
    barrel=facility(sim,'rain-barrel',current_fill=10,column=8)
    with pytest.raises(ValueError): sim.queue_facility_collection('rain-barrel','non_potable_water',1,'current_fill')
    sim.cancel_task(task['task_id'])
    assert sim.queue_facility_collection('rain-barrel','non_potable_water','all','current_fill')['amount']==5

def test_old_save_aliases_and_task_compatibility(sim):
    sim.game_state['player']['inventory']={'paper_waste':3}
    sim.game_state['player']['current_task']={'type':'walk','target':{'column':0,'row':41}}
    sim._normalize_game_state()
    assert sim._player_inventory_amount('carbonaceous_plant_waste')==3
    assert sim.state()['player']['current_task']['type']=='walk'
    sim._normalize_game_state()
    assert sim._player_inventory_amount('carbonaceous_plant_waste')==3

def test_api_all_uses_server_limits(sim):
    from app import app
    app.extensions['simulation']=sim
    sim.game_state['house']['outputs']['kitchen_waste']=60
    client=app.test_client()
    response=client.post('/api/house/pickup',json={'resource_id':'kitchen_waste','amount':'all'})
    assert response.status_code==200
    assert response.get_json()['state']['player']['committed_mass_lb']==50
    response=client.post('/api/house/pickup',json={'resource_id':'kitchen_waste','amount':1})
    assert response.status_code==400

def test_reducing_grass_reduces_assimilation(sim):
    facility(sim,'chicken-coop',current_fill=2)
    first=sim._process_default_tile()['potential_scat_assimilation_lb']
    sim.game_state['tile_states']=[{'column':i%42,'row':i//42,'type':'paved'} for i in range(500)]
    second=sim._process_default_tile()['potential_scat_assimilation_lb']
    assert first-second==pytest.approx(500*.005/24,abs=2e-6)

def test_earlier_deposit_frees_capacity_at_later_pickup(sim):
    sim._add_player_inventory('feed', 50)
    sim.queue_house_storage_transfer('feed', 'all', 'to_house')
    sim.game_state['house']['outputs']['kitchen_waste'] = 20
    assert sim.queue_house_pickup('kitchen_waste', 'all')['amount'] == 20
    finish(sim)
    assert sim._player_inventory_amount('kitchen_waste') == 20
    assert sim.carry_mass() <= 50
