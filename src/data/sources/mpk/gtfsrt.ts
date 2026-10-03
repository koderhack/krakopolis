/**
 * Minimalny dekoder protobuf dla GTFS-RT (FeedMessage).
 *
 * ZTP Kraków publikuje VehiclePositions_*.pb jako binarny GTFS-RT i – w odróżnieniu
 * od większości operatorów – nie udostępnia schema w JS. Czytamy więc surowy wire format:
 * czytamy tylko te pola, których potrzebujemy (patrz niżej numery pól = numery w .proto).
 *
 * FeedMessage      { 1 header, 2 entity[] }
 * FeedHeader       { 1 gtfs_realtime_version, 2 incrementality, 3 timestamp }
 * FeedEntity       { 1 id, 2 is_deleted, 3 trip_update, 4 vehicle, 5 alert }
 * VehiclePosition  { 1 trip, 2 position, 3 current_stop_sequence, 4 current_status,
 *                     5 timestamp, 6 congestion_level, 7 stop_id }
 * TripDescriptor   { 1 trip_id, 2 start_time, 3 start_date, 4 schedule_relationship,
 *                     5 route_id, 6 direction_id }
 * Position         { 1 latitude, 2 longitude, 3 bearing, 4 odometer, 5 speed }
 */

export interface RtTrip {
  tripId?: string;
  routeId?: string;
  directionId?: number;
}
export interface RtVehicle {
  id: string;
  trip: RtTrip;
  latitude?: number;
  longitude?: number;
  bearing?: number;
  stopSequence?: number;
  stopId?: string;
  timestamp?: number;
  /** 0 = płynny, 1 = niewielki, 2 = średni, 3 = duży, 4 = bardzo duży korek (ZTP). */
  congestionLevel?: number;
  /** 0 = pusty, 1 = nieliczni, 2 = średnie zajęcie, 3 = pełny. */
  occupancyStatus?: number;
  /** m/s – jeśli operator je podaje. */
  speed?: number;
}
export interface RtFeed {
  timestamp?: number;
  vehicles: RtVehicle[];
}

const VARINT = 0, FIXED64 = 1, LEN = 2, FIXED32 = 5;

type Field = [number, number | Uint8Array];

function readVarint(b: Uint8Array, p: number): [number, number] {
  let result = 0, shift = 0, byte: number;
  do {
    if (p >= b.length) throw new Error('GTFS-RT: niespodziewany koniec bufora');
    byte = b[p++];
    result += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('GTFS-RT: varint za długi');
  } while (byte & 0x80);
  return [result, p];
}

const view = new DataView(new ArrayBuffer(8));

function parse(buf: Uint8Array, start = 0, end = buf.length): Field[] {
  const out: Field[] = [];
  let p = start;
  while (p < end) {
    let key: number;
    [key, p] = readVarint(buf, p);
    const tag = key >> 3, wire = key & 7;
    if (wire === VARINT) {
      let v: number; [v, p] = readVarint(buf, p); out.push([tag, v]);
    } else if (wire === LEN) {
      let len: number; [len, p] = readVarint(buf, p);
      if (len < 0 || p + len > end) throw new Error('GTFS-RT: uszkodzone pole length-delimited');
      out.push([tag, buf.subarray(p, p + len)]); p += len;
    } else if (wire === FIXED32) {
      view.setUint8(0, buf[p]); view.setUint8(1, buf[p + 1]); view.setUint8(2, buf[p + 2]); view.setUint8(3, buf[p + 3]);
      view.setUint32(4, 0);
      out.push([tag, view.getFloat32(0, true)]); p += 4;
    } else if (wire === FIXED64) {
      p += 8;
    } else {
      throw new Error('GTFS-RT: nieobsługiwany wire type ' + wire);
    }
  }
  return out;
}

const str = (v: number | Uint8Array): string | undefined => (typeof v === 'number' ? String(v) : decoder.decode(v));
const bytes = (v: number | Uint8Array): Uint8Array | undefined => (typeof v === 'number' ? undefined : v);
const num = (v: number | Uint8Array): number | undefined => (typeof v === 'number' ? v : undefined);

const decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : ({ decode: (b: Uint8Array) => Buffer.from(b).toString('utf8') } as TextDecoder);

/** Dekoduje surową odpowiedź GTFS-RT na listę pozycji pojazdów. */
export function decodeFeedMessage(data: ArrayBuffer | Uint8Array): RtFeed {
  const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
  const feed: RtFeed = { vehicles: [] };
  const top = parse(buf);
  for (const [tag, val] of top) {
    if (tag === 1 && bytes(val)) {
      for (const [t2, v2] of parse(bytes(val)!)) if (t2 === 3 && num(v2) !== undefined) feed.timestamp = num(v2);
    } else if (tag === 2 && bytes(val)) {
      const vehicle = decodeVehicle(bytes(val)!);
      if (vehicle) feed.vehicles.push(vehicle);
    }
  }
  return feed;
}

function decodeVehicle(entity: Uint8Array): RtVehicle | null {
  let id = '', veh: RtVehicle | null = null;
  for (const [tag, val] of parse(entity)) {
    if (tag === 1) id = str(val) ?? id;
    else if (tag === 4 && bytes(val)) veh = decodeVehiclePosition(bytes(val)!, id);
  }
  return veh;
}

function decodeVehiclePosition(buf: Uint8Array, fallbackId: string): RtVehicle | null {
  const v: RtVehicle = { id: fallbackId, trip: {} };
  let hasPos = false;
  for (const [tag, val] of parse(buf)) {
    switch (tag) {
      case 1: {
        if (bytes(val)) for (const [t2, v2] of parse(bytes(val)!)) {
          if (t2 === 1) v.trip.tripId = str(v2);
          else if (t2 === 5) v.trip.routeId = str(v2);
          else if (t2 === 6) v.trip.directionId = num(v2);
        }
        break;
      }
      case 2: {
        if (bytes(val)) for (const [t2, v2] of parse(bytes(val)!)) {
          if (t2 === 1) { v.latitude = num(v2); hasPos = v.latitude !== undefined; }
          else if (t2 === 2) v.longitude = num(v2);
          else if (t2 === 3) v.bearing = num(v2);
          else if (t2 === 5) v.speed = num(v2);
        }
        break;
      }
      case 3: v.stopSequence = num(val); break;
      case 4: break; // current_status – pomijamy
      case 5: v.timestamp = num(val); break;
      case 6: v.congestionLevel = num(val); break;
      case 7: v.stopId = str(val); break;
    }
  }
  if (!hasPos || v.latitude === undefined || v.longitude === undefined) return null;
  if (!isFinite(v.latitude) || !isFinite(v.longitude)) return null;
  if (v.latitude < -90 || v.latitude > 90 || v.longitude < -180 || v.longitude > 180) return null;
  return v;
}