import { describe, it } from 'mocha';
import { expect } from 'chai';
import type { FuelModel, TireModel } from '@iracing-engineer/types';
import { getFuelStatus, getTireStatus, createTools } from '../../../src/engineer/tools.js';

function fuelModel(over: Partial<FuelModel> = {}): FuelModel {
  return {
    burnRatePerLap: 2.6,
    burnRateConfidence: 0.9,
    fuelRemaining: 18.4,
    lapsRemaining: 7,
    fuelToFinish: 20,
    fuelDeficit: 0,
    confidenceLevel: 'high',
    dataSource: 'measured',
    lapsSinceCalibration: 3,
    summary: 'ok',
    timeRemaining: null,
    ...over,
  } as FuelModel;
}

function tireModel(over: Partial<TireModel> = {}): TireModel {
  return {
    compound: 'soft',
    lapAge: 7,
    setsRemaining: 3,
    paceDegradationTrend: 0.02,
    degradationSignal: 'nominal',
    degradationConfidence: 'medium',
    ...over,
  } as TireModel;
}

describe('tools — get_fuel_status (FR-007/008)', () => {
  it('returns available data from the fuel model', () => {
    const r = getFuelStatus({ getFuelModel: () => fuelModel(), getTireModel: () => null });
    expect(r.available).to.be.true;
    expect(r.data?.lapsRemaining).to.equal(7);
    expect(r.data?.burnRatePerLap).to.equal(2.6);
  });
  it('reports unavailable when no fuel model exists', () => {
    const r = getFuelStatus({ getFuelModel: () => null, getTireModel: () => null });
    expect(r.available).to.be.false;
    expect(r.reason).to.match(/not yet available/);
  });
});

describe('tools — get_tire_status (FR-007/008)', () => {
  it('returns available data once there is a flying lap', () => {
    const r = getTireStatus({ getFuelModel: () => null, getTireModel: () => tireModel({ lapAge: 5 }) });
    expect(r.available).to.be.true;
    expect(r.data?.compound).to.equal('soft');
    expect(r.data?.lapAge).to.equal(5);
  });
  it('reports unavailable before the first flying lap (lapAge 0)', () => {
    const r = getTireStatus({ getFuelModel: () => null, getTireModel: () => tireModel({ lapAge: 0 }) });
    expect(r.available).to.be.false;
    expect(r.reason).to.match(/no flying lap/);
  });
  it('reports unavailable when no tire model exists', () => {
    const r = getTireStatus({ getFuelModel: () => null, getTireModel: () => null });
    expect(r.available).to.be.false;
  });
});

describe('tools — createTools dispatch', () => {
  const tools = createTools({ getFuelModel: () => fuelModel(), getTireModel: () => tireModel() });
  it('exposes both tool schemas', () => {
    expect(tools.schemas.map((s) => s.function.name)).to.have.members(['get_fuel_status', 'get_tire_status']);
  });
  it('runs a tool by name', () => {
    expect(tools.run('get_fuel_status').available).to.be.true;
  });
  it('returns unavailable for an unknown tool', () => {
    const r = tools.run('get_weather');
    expect(r.available).to.be.false;
    expect(r.reason).to.match(/unknown tool/);
  });
});
