import json
from pathlib import Path
import pytest
from simulation import Simulation

ROOT = Path(__file__).resolve().parents[1]

@pytest.fixture
def sim(tmp_path):
    path = tmp_path / 'garden-save.json'
    path.write_text((ROOT/'NewGame.json').read_text())
    return Simulation(ROOT/'facilities.json', ROOT/'resources.json', ROOT/'HouseholdProfile.json', path)

def prepared(sim, **values):
    p={'instance_id':'garden_test','facility_id':'garden-plot','column':2,'row':2,'width':1,'height':1,**values}
    sim._normalize_instance(p)
    sim.game_state['facilities'].append(p)
    return p

def plant(sim, plot, crop='russet_burbank'):
    rule=sim.crop_definitions[crop]
    sim._add_player_inventory(rule['planting_resource'],rule['planting_quantity'])
    task=sim.queue_garden_action(plot['instance_id'],'plant',crop_id=crop)
    sim.advance_minutes(task['work_minutes_total']+2)
    return plot

def grow(sim, plot, hours, water=True, labor=True):
    for _ in range(hours):
        if water: plot['irrigation_water_gal']=5
        if labor:
            plot['accrued_labor_requirement']=0
            for event in plot['pending_crop_events']: event['completed']=True
        sim._process_garden(plot,sim.facility_definitions['garden-plot'])


def test_conversion_requires_carried_amendment_and_labor(sim):
    before=sim._active_default_tile_count()
    with pytest.raises(ValueError): sim.place_facility('garden-plot',2,2)
    assert not sim.game_state['facilities']
    sim.order_house_material('commercial_garden_amendment',2)
    with pytest.raises(ValueError): sim.place_facility('garden-plot',2,2)
    sim.queue_house_storage_transfer('commercial_garden_amendment','all','to_player')
    sim.advance_minutes(3)
    p=sim.place_facility('garden-plot',2,2)
    assert p['width']==p['height']==1
    assert p['plot_state']=='preparing'
    assert sim._active_default_tile_count()==before-1
    task=sim.game_state['player']['task_queue'][0]
    assert task['work_minutes_total']==90
    assert sim._player_inventory_amount('commercial_garden_amendment')==0
    sim.advance_minutes(91)
    p=sim._find_facility_instance(p['instance_id'])
    assert p['plot_state']=='prepared'
    assert p['fertility']==pytest.approx(95)
    assert not sim._point_blocked(**sim.game_state['player']['position'])


def test_compost_preparation_and_cancel_restore_land(sim):
    sim._add_player_inventory('bucket',1)
    sim._add_player_inventory('compost',10)
    count=sim._active_default_tile_count()
    sim.place_facility('garden-plot',2,2)
    task=sim.game_state['player']['task_queue'][0]
    assert task['resource_id']=='compost' and task['amount']==10
    sim.cancel_task(task['task_id'])
    assert sim._active_default_tile_count()==count
    assert sim._player_inventory_amount('compost')==10


def test_cannot_prepare_non_grass_or_overlap(sim):
    sim._add_player_inventory('commercial_garden_amendment',4)
    sim.game_state['tile_states']=[{'column':2,'row':2,'type':'paved'}]
    with pytest.raises(ValueError): sim.place_facility('garden-plot',2,2)
    sim.game_state['tile_states']=[]
    sim.place_facility('garden-plot',2,2)
    with pytest.raises(ValueError): sim.place_facility('garden-plot',2,2)


def test_lawn_functions_shrink_by_one_plot(sim):
    old=sim._process_default_tile()
    prepared(sim)
    new=sim._process_default_tile()
    assert old['active_tiles']-new['active_tiles']==1
    assert old['potential_scat_assimilation_lb']-new['potential_scat_assimilation_lb']==pytest.approx(.005/24,abs=1e-6)
    for rid in ('insect_forage','green_forage'):
        assert old['yard_forage'][rid]['daily_generation']>new['yard_forage'][rid]['daily_generation']


@pytest.mark.parametrize('fertility,commercial,compost',[(95,0,0),(47.5,1,5),(0,2,10)])
def test_remediation_scales_and_requires_physical_work(sim,fertility,commercial,compost):
    p=prepared(sim,plot_state='harvested',fertility=fertility)
    g=sim.garden_status(p)
    assert g['amendment_requirements_lb']['commercial_garden_amendment']==pytest.approx(commercial)
    assert g['amendment_requirements_lb']['compost']==pytest.approx(compost)
    sim._add_player_inventory('commercial_garden_amendment',commercial)
    t=sim.queue_garden_action(p['instance_id'],'remediate',amendment_resource_id='commercial_garden_amendment')
    assert t['work_minutes_total']==15<90
    assert p['plot_state']=='harvested'
    sim.advance_minutes(16)
    assert p['plot_state']=='prepared' and p['fertility']==95


@pytest.mark.parametrize('crop,rid,amount',[('russet_burbank','seed_potato',.8),('beefsteak_tomato','tomato_transplant',2)])
def test_plant_inputs_reserved_and_refunded(sim,crop,rid,amount):
    p=prepared(sim)
    with pytest.raises(ValueError): sim.queue_garden_action(p['instance_id'],'plant',crop_id=crop)
    sim._add_player_inventory(rid,amount)
    t=sim.queue_garden_action(p['instance_id'],'plant',crop_id=crop)
    assert sim._player_inventory_amount(rid)==0
    with pytest.raises(ValueError): sim.queue_garden_action(p['instance_id'],'plant',crop_id=crop)
    sim.cancel_task(t['task_id'])
    assert sim._player_inventory_amount(rid)==amount
    plant(sim,p,crop)
    assert p['crop_id']==crop and p['plot_state']=='planted'


@pytest.mark.parametrize('state',['preparing','harvested','planted','harvestable'])
def test_only_prepared_can_plant(sim,state):
    p=prepared(sim,plot_state=state)
    sim._add_player_inventory('seed_potato',.8)
    with pytest.raises(ValueError): sim.queue_garden_action(p['instance_id'],'plant',crop_id='russet_burbank')


def test_shared_rainfall_barrel_and_garden(sim):
    assert sim.rainfall_gallons_per_day(100)==pytest.approx(10,abs=.03)
    assert sim.rainfall_gallons_per_day(25)==pytest.approx(2.5,abs=.01)
    barrel={'current_fill':0}
    for _ in range(24): sim._process_rain_barrel(barrel,sim.facility_definitions['rain-barrel'])
    assert barrel['current_fill']==pytest.approx(10,abs=.03)
    p=plant(sim,prepared(sim))
    p['crop_age_hours']=57*24
    g=sim.garden_status(p)
    assert g['water_requirement_gal_per_day']==4
    assert g['supplemental_water_gal_per_day']==pytest.approx(1.5,abs=.01)
    grow(sim,p,24,water=False)
    assert p['irrigation_water_gal']==0
    assert sim.game_state['inventories']['non_potable_water']==0
    assert sim._garden_performance(p)['water']<1


def test_bucket_irrigation_uses_existing_delivery_path(sim):
    p=plant(sim,prepared(sim))
    p['crop_age_hours']=57*24
    sim._add_player_inventory('bucket',1)
    sim._add_player_inventory('non_potable_water',5)
    t=sim.queue_facility_fill(p['instance_id'],'non_potable_water','all')
    assert t['amount']==5
    assert p['irrigation_water_gal']==0
    sim.advance_minutes(3)
    assert p['irrigation_water_gal']==5
    grow(sim,p,1,water=False)
    assert 0<p['irrigation_water_gal']<5
    assert sim._player_inventory_amount('non_potable_water')==0


@pytest.mark.parametrize('day,phase,water',[(1,'Establishment',2.5),(21,'Vegetative',3),(46,'Tuber',4),(96,'Maturation',2),(111,'Senescence',.5)])
def test_potato_phases(sim,day,phase,water):
    p=plant(sim,prepared(sim)); p['crop_age_hours']=day*24
    g=sim.garden_status(p)
    assert g['phase'].startswith(phase)
    assert g['water_requirement_gal_per_day']==water


def test_potato_terminal_harvest_local_and_carry_limit(sim):
    p=plant(sim,prepared(sim))
    initial=p['fertility']
    grow(sim,p,125*24)
    assert p['plot_state']=='harvestable'
    assert p['fertility']==pytest.approx(initial-40)
    assert p['stored_outputs'].get('potato',0)==0
    after=p['fertility']
    t=sim.queue_garden_action(p['instance_id'],'harvest')
    assert t['work_minutes_total']==45
    sim.advance_minutes(46)
    assert p['plot_state']=='harvested' and p['crop_id'] is None
    assert p['fertility']==after
    assert p['stored_outputs']['potato']==pytest.approx(19.3,abs=.01)
    assert sim._player_inventory_amount('potato')==0
    sim._add_player_inventory('feed',45)
    t=sim.queue_facility_collection(p['instance_id'],'potato','all')
    assert t['amount']==5
    sim.advance_minutes(3)
    assert sim._player_inventory_amount('potato')==5
    assert p['stored_outputs']['potato']>14


def test_tomato_repeated_yield_and_end_state(sim):
    p=plant(sim,prepared(sim),'beefsteak_tomato')
    grow(sim,p,80*24)
    assert p['plot_state']=='harvestable'
    assert p['stored_outputs'].get('tomato',0)==0
    grow(sim,p,2*24)
    first=p['stored_outputs']['tomato']
    assert 0<first<1
    t=sim.queue_facility_collection(p['instance_id'],'tomato','all')
    assert t['work_minutes_total']==5
    sim.advance_minutes(6)
    assert sim._player_inventory_amount('tomato')==pytest.approx(first)
    grow(sim,p,61*24)
    assert p['plot_state']=='harvested' and p['crop_id'] is None
    assert p['seasonal_yield_produced']==pytest.approx(17,abs=.02)
    assert p['stored_outputs']['tomato']+first==pytest.approx(17,abs=.02)
    assert p['fertility']==pytest.approx(50)


@pytest.mark.parametrize('day,phase',[(1,'Transplant'),(15,'Vegetative'),(36,'Flowering'),(61,'Fruit'),(81,'Harvest')])
def test_tomato_phases(sim,day,phase):
    p=plant(sim,prepared(sim),'beefsteak_tomato');p['crop_age_hours']=day*24
    assert sim.garden_status(p)['phase'].startswith(phase)


@pytest.mark.parametrize('deficiency',['water','labor','fertility','temporary'])
def test_performance_penalties_are_gradual(sim,deficiency):
    p=plant(sim,prepared(sim))
    if deficiency=='water': sim.facility_config['environment']['average_rainfall_inches_per_day']=0
    if deficiency=='fertility': p['fertility']=20
    if deficiency=='temporary':
        sim.facility_config['environment']['average_rainfall_inches_per_day']=0
        grow(sim,p,1,water=False)
        sim.facility_config['environment']['average_rainfall_inches_per_day']=.160
        grow(sim,p,125*24-1)
        assert .99<sim.garden_status(p)['performance_multiplier']<=1
    else:
        grow(sim,p,125*24,water=deficiency!='water',labor=deficiency!='labor')
        assert sim.garden_status(p)['performance_multiplier']<.9
    assert p['plot_state']=='harvestable'


def test_major_event_due_and_cancellation(sim):
    p=plant(sim,prepared(sim));p['crop_age_hours']=28*24
    due=sim.garden_status(p)['due_events']
    assert {e['id'] for e in due}=={'early_weeding','first_hilling'}
    t=sim.queue_garden_action(p['instance_id'],'event',event_id='first_hilling')
    sim.cancel_task(t['task_id'])
    assert not p['pending_crop_events'][1].get('completed')
    t=sim.queue_garden_action(p['instance_id'],'event',event_id='first_hilling')
    sim.advance_minutes(t['work_minutes_total']+1)
    assert p['pending_crop_events'][1]['completed']


def test_legacy_footprint_migration_preserves_area_and_outputs(sim):
    p=prepared(sim,width=4,height=2,stored_outputs={'potato':7})
    before=sim._active_default_tile_count()
    sim._normalize_game_state()
    gardens=[p for p in sim.game_state['facilities'] if p['facility_id']=='garden-plot']
    assert len(gardens)==8
    assert all(p['width']==p['height']==1 and p['plot_state']=='prepared' for p in gardens)
    assert sim._active_default_tile_count()==before
    assert sum(p['stored_outputs'].get('potato',0) for p in gardens)==7
    sim._normalize_game_state()
    assert len(sim.game_state['facilities'])==8


@pytest.mark.parametrize('state',['prepared','planted','harvestable','harvested'])
def test_backend_inspector_and_save_roundtrip(sim,state):
    p=prepared(sim,plot_state=state)
    if state in ('planted','harvestable'): p['crop_id']='russet_burbank'
    g=sim.state()['instances'][0]['garden_status']
    for key in ('display_name','fertility','phase','crop_age_days','rainfall_gal_per_day','supplemental_water_still_required_gal','performance','projected_yield_lb','amendment_requirements_lb'):
        assert key in g
    sim.save()
    sim.load_game_state()
    assert sim.game_state['facilities'][0]['plot_state']==state


def test_garden_api_and_grass_plant_rejection(sim):
    from app import app
    app.extensions['simulation']=sim
    client=app.test_client()
    sim._add_player_inventory('commercial_garden_amendment',2)
    response=client.post('/api/facilities',json={'facility_id':'garden-plot','column':2,'row':2})
    assert response.status_code==201
    iid=response.get_json()['instance']['instance_id']
    assert client.post('/api/gardens/'+iid+'/action',json={'action':'plant','crop_id':'russet_burbank'}).status_code==400
    sim.advance_minutes(91)
    sim._add_player_inventory('seed_potato',.8)
    assert client.post('/api/gardens/'+iid+'/action',json={'action':'plant','crop_id':'russet_burbank'}).status_code==200
    assert client.post('/api/gardens/grass/action',json={'action':'plant','crop_id':'russet_burbank'}).status_code==400

def test_irrigation_after_season_end_returns_reserved_water(sim):
    p=plant(sim,prepared(sim),'beefsteak_tomato')
    sim._add_player_inventory('bucket',1)
    sim._add_player_inventory('non_potable_water',5)
    sim.queue_facility_fill(p['instance_id'],'non_potable_water',5)
    sim._finish_garden_crop(p)
    sim.advance_minutes(3)
    assert p['irrigation_water_gal']==0
    assert sim._player_inventory_amount('non_potable_water')==5
    assert sim.carry_mass()<=50


def test_mid_preparation_save_load_continues_once(sim):
    sim._add_player_inventory('commercial_garden_amendment',2)
    p=sim.place_facility('garden-plot',2,2)
    sim.advance_minutes(30)
    sim.load_game_state()
    assert len(sim.game_state['facilities'])==1
    sim.advance_minutes(62)
    p=sim._find_facility_instance(p['instance_id'])
    assert p['plot_state']=='prepared' and p['fertility']==95
    assert not sim.game_state['player']['task_queue']
    assert sim._player_inventory_amount('commercial_garden_amendment')==0


def test_existing_solar_and_compost_flows_unchanged_with_garden(sim):
    prepared(sim)
    solar=sim.place_facility('solar-array',10,10)
    pile=sim.place_facility('compost-pile',20,20)
    actual=sim._find_facility_instance(pile['instance_id'])
    actual.update(feedstock_mass=100,active_compost_mass=50,mature_compost_mass=10)
    before=sim.compost_balance(actual)
    result=sim.advance_hour()
    assert result['state']['current_flows']['electricity_generated_this_tick_kwh']>0
    assert actual['feedstock_mass']<100
    assert actual['mature_compost_mass']>10
    assert sim.compost_balance(actual)==before
    assert sim.game_state['inventories']['compost']==0


def test_prepared_low_fertility_planting_warns_but_is_legal(sim):
    p=prepared(sim,fertility=10)
    assert sim.garden_status(p)['fertility_warning']
    plant(sim,p)
    assert p['crop_id']=='russet_burbank'
    assert p['fertility']==10


def test_replant_retains_soil_and_previous_local_output(sim):
    p=prepared(sim,plot_state='harvested',fertility=47.5,stored_outputs={'potato':6})
    sim._add_player_inventory('commercial_garden_amendment',1)
    sim.queue_garden_action(p['instance_id'],'remediate')
    sim.advance_minutes(16)
    plant(sim,p,'beefsteak_tomato')
    assert p['fertility']==95
    assert p['stored_outputs']['potato']==6
    assert p['crop_id']=='beefsteak_tomato'
