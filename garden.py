"""Garden land, crop biology and status. Tunable values live in JSON definitions."""
import math
from copy import deepcopy


class GardenMixin:
    def garden_rules(self):
        return self.facility_definitions['garden-plot']['garden']

    def rainfall_gallons_per_day(self, area_sq_ft):
        climate = self.facility_config['environment']
        return float(climate['average_rainfall_inches_per_day']) * float(climate['gallons_per_inch_sq_ft']) * area_sq_ft

    def _normalize_garden(self, plot):
        plot.setdefault('plot_state', 'prepared')
        plot.setdefault('fertility', self.garden_rules()['target_fertility'])
        plot['fertility'] = max(0.0, min(100.0, float(plot['fertility'])))
        for key, value in {'crop_id': None, 'crop_age_hours': 0.0, 'irrigation_water_gal': 0.0,
                           'performance_samples': 0, 'water_satisfaction_sum': 0.0,
                           'labor_satisfaction_sum': 0.0, 'fertility_satisfaction_sum': 0.0,
                           'seasonal_yield_produced': 0.0, 'production_days_released': 0.0,
                           'pending_crop_events': []}.items():
            plot.setdefault(key, deepcopy(value))

    def _migrate_garden_footprints(self):
        # Old decorative plots occupied multiple tiles. Preserve their entire
        # land investment, but never duplicate stored outputs or active crops.
        extra = []
        ids = {p.get('instance_id') for p in self.game_state['facilities']}
        for plot in self.game_state['facilities']:
            if plot.get('facility_id', plot.get('type')) != 'garden-plot':
                continue
            width, height = int(plot.get('width', 1)), int(plot.get('height', 1))
            if width == height == 1:
                continue
            plot['width'] = plot['height'] = 1
            for row in range(height):
                for col in range(width):
                    if col == row == 0:
                        continue
                    name = f"{plot['instance_id']}-soil-{col}-{row}"
                    if name in ids:
                        continue
                    tile = {'instance_id': name, 'facility_id': 'garden-plot',
                            'column': plot.get('column', plot.get('x', 0)) + col,
                            'row': plot.get('row', plot.get('y', 0)) + row, 'width': 1, 'height': 1,
                            'plot_state': 'prepared', 'fertility': self.garden_rules()['target_fertility']}
                    extra.append(tile)
                    ids.add(name)
        self.game_state['facilities'].extend(extra)

    def _garden_phase(self, plot):
        crop = self.crop_definitions.get(plot.get('crop_id'))
        if not crop:
            return None
        age = float(plot['crop_age_hours']) / 24
        return next((p for p in crop['phases'] if age < p['end_day']), crop['phases'][-1])

    def _garden_performance(self, plot):
        count = plot.get('performance_samples', 0)
        if not count:
            return {'water': 1.0, 'labor': 1.0, 'fertility': min(1.0, plot['fertility'] / self.crop_config['performance']['full_fertility_threshold'])}
        return {key: max(0.0, min(1.0, plot[key + '_satisfaction_sum'] / count))
                for key in ('water', 'labor', 'fertility')}

    def _garden_busy(self, plot):
        return any(t.get('type') == 'garden_work' and t.get('target_instance_id') == plot['instance_id']
                   for t in self.game_state['player']['task_queue'])

    def _amendment_requirement(self, plot, resource_id):
        rule = self.garden_rules()['amendments'].get(resource_id)
        if not rule:
            raise ValueError('Choose mature compost or commercial garden amendment.')
        return max(0.0, self.garden_rules()['target_fertility'] - plot['fertility']) / rule['fertility_per_lb']

    def _choose_amendment(self, plot, resource_id=None):
        if resource_id:
            return resource_id, self._amendment_requirement(plot, resource_id)
        for rid in ('commercial_garden_amendment', 'compost'):
            quantity = self._amendment_requirement(plot, rid)
            if self._player_inventory_amount(rid) + 1e-9 >= quantity:
                return rid, quantity
        raise ValueError('Carry enough mature compost or commercial garden amendment; see preparation requirements.')

    def _queue_garden_work(self, plot, action, labor_hours, resource_id=None, amount=0, **details):
        self._nearest_adjacent_tile(plot)  # Validate before reserving material.
        task = {'type': 'garden_work', 'garden_action': action, 'target_instance_id': plot['instance_id'],
                'description': f"{action.replace('_', ' ').capitalize()}: {self.garden_status(plot)['display_name']}",
                'work_minutes_total': max(1, math.ceil(labor_hours * 60)),
                'work_minutes_remaining': max(1, math.ceil(labor_hours * 60)), **details}
        if amount > 1e-9:
            amount = self._transfer_amount(resource_id, amount, self._player_inventory_amount(resource_id))
            self._consume_player_inventory(resource_id, amount)
            task.update(resource_id=resource_id, amount=amount,
                        reserved_cargo={'resource_id': resource_id, 'amount': amount, 'source': 'player'})
        return self._queue_task(task)

    def queue_garden_action(self, instance_id, action, crop_id=None, amendment_resource_id=None, event_id=None):
        plot = self._find_facility_instance(instance_id)
        if plot.get('facility_id') != 'garden-plot':
            raise ValueError('Select a garden plot.')
        if self._garden_busy(plot):
            raise ValueError('This plot already has a major garden task queued.')
        state = plot['plot_state']
        if action == 'remediate':
            if state != 'harvested':
                raise ValueError('Only a harvested plot can be remediated.')
            rid, quantity = self._choose_amendment(plot, amendment_resource_id)
            return self._queue_garden_work(plot, action, self.garden_rules()['remediation_labor_hours'], rid, quantity)
        if action == 'plant':
            if state != 'prepared' or plot.get('crop_id'):
                raise ValueError('Plant only in prepared, empty garden soil.')
            crop = self.crop_definitions.get(crop_id)
            if not crop:
                raise ValueError('Unknown crop.')
            return self._queue_garden_work(plot, action, crop['planting_labor_hours'],
                                           crop['planting_resource'], crop['planting_quantity'], crop_id=crop_id)
        crop = self.crop_definitions.get(plot.get('crop_id'))
        if not crop:
            raise ValueError('There is no active crop here.')
        if action == 'harvest':
            if state != 'harvestable' or crop['growth_habit'] != 'annual_single_harvest':
                raise ValueError('This crop is not ready for a terminal harvest.')
            return self._queue_garden_work(plot, action, crop['harvest_labor_hours'])
        if action == 'event':
            event = next((e for e in plot['pending_crop_events'] if e['id'] == event_id), None)
            if not event or event.get('completed') or event['day'] * 24 > plot['crop_age_hours']:
                raise ValueError('This labor event is not due.')
            return self._queue_garden_work(plot, action, event['labor_hours'], event_id=event_id)
        raise ValueError('Unknown garden action.')

    def _complete_garden_work(self, task):
        plot = self._find_facility_instance(task['target_instance_id'])
        action = task['garden_action']
        if action in ('prepare', 'remediate'):
            rid, amount = task.get('resource_id'), task.get('amount', 0)
            if amount:
                plot['fertility'] = min(100, plot['fertility'] + amount * self.garden_rules()['amendments'][rid]['fertility_per_lb'])
            plot['plot_state'] = 'prepared'
            if action == 'remediate':
                plot.update(crop_age_hours=0, performance_samples=0,
                            water_satisfaction_sum=0.0, labor_satisfaction_sum=0.0,
                            fertility_satisfaction_sum=0.0, seasonal_yield_produced=0.0,
                            production_days_released=0.0, accrued_labor_requirement=0.0)
        elif action == 'plant':
            crop = self.crop_definitions[task['crop_id']]
            plot.update(plot_state='planted', crop_id=task['crop_id'], crop_age_hours=0,
                        performance_samples=0, water_satisfaction_sum=0.0, labor_satisfaction_sum=0.0,
                        fertility_satisfaction_sum=0.0, seasonal_yield_produced=0.0, production_days_released=0.0,
                        pending_crop_events=deepcopy(crop['labor_events']), accrued_labor_requirement=0.0)
        elif action == 'event':
            for event in plot['pending_crop_events']:
                if event['id'] == task['event_id']:
                    event['completed'] = True
        elif action == 'harvest':
            crop = self.crop_definitions[plot['crop_id']]
            perf = self._garden_performance(plot)
            amount = crop['expected_harvest_lb'] * math.prod(perf.values())
            rid = crop['harvest_resource']
            plot['stored_outputs'][rid] = plot['stored_outputs'].get(rid, 0) + amount
            plot['seasonal_yield_produced'] = amount
            self._finish_garden_crop(plot)

    def _finish_garden_crop(self, plot):
        plot['last_crop_summary'] = {'crop_id': plot['crop_id'], 'age_days': plot['crop_age_hours'] / 24,
                                     'yield_produced_lb': plot['seasonal_yield_produced'],
                                     'performance': self._garden_performance(plot)}
        plot['last_crop_id'] = plot['crop_id']
        plot['crop_id'] = None
        plot['plot_state'] = 'harvested'
        plot['pending_crop_events'] = []
        plot['irrigation_water_gal'] = 0.0

    def _process_garden(self, plot, definition):
        crop = self.crop_definitions.get(plot.get('crop_id'))
        if not crop or (plot['plot_state'] == 'harvestable' and crop['growth_habit'] == 'annual_single_harvest'):
            return {'status': plot['plot_state'], 'garden': self.garden_status(plot)}
        phase = self._garden_phase(plot)
        rain = self.rainfall_gallons_per_day(self.garden_rules()['area_sq_ft']) / 24
        demand = phase['water_gal_per_day'] / 24
        irrigation = min(plot['irrigation_water_gal'], max(0.0, demand - rain))
        plot['irrigation_water_gal'] -= irrigation
        water = min(1.0, (rain + irrigation) / demand) if demand else 1.0
        plot['accrued_labor_requirement'] += phase['routine_labor_hours_per_day'] / 24
        due = sum(e['labor_hours'] for e in plot['pending_crop_events']
                  if not e.get('completed') and e['day'] * 24 <= plot['crop_age_hours'])
        perf = self.crop_config['performance']
        labor = max(perf['minimum_labor_satisfaction'], 1 - max(0.0, plot['accrued_labor_requirement'] + due - perf['labor_grace_hours']) / perf['labor_backlog_tolerance_hours'])
        fertility = min(1.0, plot['fertility'] / perf['full_fertility_threshold'])
        for key, value in (('water', water), ('labor', labor), ('fertility', fertility)):
            plot[key + '_satisfaction_sum'] += value
        plot['performance_samples'] += 1
        plot['fertility'] = max(0.0, plot['fertility'] - crop['seasonal_fertility_draw'] / (crop['season_days'] * 24))
        plot['crop_age_hours'] += 1
        age = plot['crop_age_hours'] / 24
        if crop['growth_habit'] == 'annual_single_harvest':
            if age >= crop['maturity_days']:
                plot['plot_state'] = 'harvestable'
        elif age >= crop['maturity_days']:
            plot['plot_state'] = 'harvestable'
            window = crop['season_days'] - crop['maturity_days']
            elapsed = min(window, max(0, age - crop['maturity_days']))
            interval = crop['harvest_interval_days']
            release_days = window if elapsed >= window else math.floor((elapsed + 1e-9) / interval) * interval
            additional = max(0.0, release_days - plot['production_days_released'])
            if additional:
                amount = crop['expected_harvest_lb'] * additional / window * math.prod(self._garden_performance(plot).values())
                rid = crop['harvest_resource']
                plot['stored_outputs'][rid] = plot['stored_outputs'].get(rid, 0) + amount
                plot['seasonal_yield_produced'] += amount
                plot['production_days_released'] = release_days
            if age >= crop['season_days']:
                self._finish_garden_crop(plot)
        return {'status': plot['plot_state'], 'garden': self.garden_status(plot)}

    def garden_status(self, plot):
        crop = self.crop_definitions.get(plot.get('crop_id'))
        phase = self._garden_phase(plot)
        rain = self.rainfall_gallons_per_day(self.garden_rules()['area_sq_ft'])
        demand = phase['water_gal_per_day'] if phase else 0.0
        performance = self._garden_performance(plot)
        pending = [e for e in plot['pending_crop_events'] if not e.get('completed')]
        state = plot['plot_state']
        names = {'preparing': 'Garden Plot - preparation in progress', 'prepared': 'Prepared Garden Plot', 'harvested': 'Harvested Garden Plot'}
        name = crop.get('plot_display_name', crop['name'] + ' Garden Plot') if crop else names.get(state, 'Garden Plot')
        labels = {'preparing': 'Preparing soil', 'prepared': 'Ready to plant', 'planted': 'Growing', 'harvestable': 'Harvestable', 'harvested': 'Needs remediation'}
        supplemental = max(0.0, demand - rain)
        next_event = deepcopy(pending[0]) if pending else None
        if crop and not next_event:
            if crop['growth_habit'] == 'annual_single_harvest':
                next_event = {'name': 'Final digging / harvest', 'day': crop['maturity_days'],
                              'labor_hours': crop['harvest_labor_hours']}
            else:
                next_event = {'name': 'Next tomato picking',
                              'day': min(crop['season_days'], crop['maturity_days'] + plot['production_days_released'] + crop['harvest_interval_days']),
                              'labor_hours': crop['harvest_labor_hours']}
        return {'display_name': name, 'state': state, 'state_description': labels.get(state, state),
                'fertility': plot['fertility'], 'fertility_warning': 'Poor fertility: reduced yield expected' if plot['fertility'] < self.garden_rules()['poor_fertility_warning_below'] else '',
                'crop_name': crop['name'] if crop else None, 'crop_age_days': plot['crop_age_hours'] / 24,
                'phase': phase['name'] if phase else None,
                'days_until_next_phase': max(0, phase['end_day'] - plot['crop_age_hours'] / 24) if phase else None,
                'season_days': crop['season_days'] if crop else None,
                'water_requirement_gal_per_day': demand, 'rainfall_gal_per_day': rain,
                'effective_rainfall_gal_per_day': min(demand, rain), 'supplemental_water_gal_per_day': supplemental,
                'supplemental_water_still_required_gal': max(0, supplemental - plot['irrigation_water_gal']),
                'irrigation_water_gal': plot['irrigation_water_gal'],
                'current_water_satisfaction': min(1.0, (rain + plot['irrigation_water_gal']) / demand) if demand else 1.0,
                'performance': performance, 'performance_multiplier': math.prod(performance.values()),
                'routine_labor_hours': plot.get('accrued_labor_requirement', 0),
                'next_event': next_event,
                'due_events': [deepcopy(e) for e in pending if e['day'] * 24 <= plot['crop_age_hours']],
                'full_yield_lb': crop['expected_harvest_lb'] if crop else None,
                'projected_yield_lb': crop['expected_harvest_lb'] * math.prod(performance.values()) if crop else plot['seasonal_yield_produced'],
                'seasonal_yield_produced_lb': plot['seasonal_yield_produced'], 'stored_outputs': deepcopy(plot.get('stored_outputs', {})),
                'remediation_labor_hours': self.garden_rules()['remediation_labor_hours'],
                'amendment_requirements_lb': {r: self._amendment_requirement(plot, r) for r in self.garden_rules()['amendments']},
                'busy': self._garden_busy(plot)}

