import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { prisma } from '@hexfleet/db';

const app = Fastify({ logger: false });
await app.register(cors, { origin: true });
await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });

app.addHook('onRequest', async (request) => {
  request.hexFleetStartedAt = Date.now();
});
app.addHook('onResponse', async (request, reply) => {
  const duration = Date.now() - (request.hexFleetStartedAt ?? Date.now());
  const source = /^\/api\/[0-9A-Fa-f]{12}\/(health|rfid|telemetry)(?:\?|$)/.test(request.url) ? 'ESP' : 'WEB';
  console.log(`[${source}] ${request.method} ${request.url} -> ${reply.statusCode} (${duration}ms)`);
});
app.addHook('onError', async (request, _reply, error) => {
  const source = /^\/api\/[0-9A-Fa-f]{12}\/(health|rfid|telemetry)(?:\?|$)/.test(request.url) ? 'ESP' : 'WEB';
  console.error(`[${source}] ${request.method} ${request.url} -> ERROR: ${error.message}`);
});

const now = () => new Date();
const normalizeMac = (value) => String(value ?? '').replace(/[:-]/g, '').replace(/\s/g, '').toUpperCase();
const asDate = (value, fallback = now()) => {
  if (!value) return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
};
const asNumber = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
function listQuery(items, query = {}) {
  const requested = query.page !== undefined || query.pageSize !== undefined || query.search !== undefined;
  if (!requested) return items;
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 25));
  const page = Math.max(1, Number(query.page) || 1);
  const search = String(query.search ?? '').trim().toLowerCase();
  const filtered = search ? items.filter((item) => JSON.stringify(item).toLowerCase().includes(search)) : items;
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pages);
  return { items: filtered.slice((safePage - 1) * pageSize, safePage * pageSize), pagination: { page: safePage, pageSize, pages, total: filtered.length, search } };
}

async function getDevice(request, reply) {
  const macAddress = normalizeMac(request.params.macId);
  if (!/^[0-9A-F]{12}$/.test(macAddress)) {
    reply.code(400).send({ success: false, error: 'Invalid MACID format' });
    return null;
  }
  const device = await prisma.microcontroller.findUnique({ where: { macAddress } });
  if (!device) {
    reply.code(404).send({ success: false, error: 'Microcontroller is not registered' });
    return null;
  }
  if (!device.isActive) {
    reply.code(403).send({ success: false, error: 'Microcontroller is inactive' });
    return null;
  }
  return device;
}

app.get('/health', async () => ({ status: 'ok', service: 'hexfleet-api', timestamp: now().toISOString() }));

function startOfToday() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

function deviceIsOnline(lastApiDataReceived) {
  return Boolean(lastApiDataReceived && now().getTime() - new Date(lastApiDataReceived).getTime() <= 10 * 60 * 1000);
}

async function dashboardSnapshot() {
  const today = startOfToday();
  const [devices, students, attendanceToday, recentAttendance, gpsLogs, fuelSensors] = await Promise.all([
    prisma.microcontroller.findMany({ orderBy: { createdAt: 'asc' }, include: { busMappings: { where: { isActive: true }, include: { bus: true } } } }),
    prisma.student.count({ where: { isActive: true } }),
    prisma.studentAttendanceLog.count({ where: { scannedAt: { gte: today } } }),
    prisma.studentAttendanceLog.findMany({
      where: { scannedAt: { gte: today } }, orderBy: { scannedAt: 'desc' }, take: 20,
      include: { student: true, microcontroller: true, bus: true }
    }),
    prisma.gpsLog.findMany({ orderBy: { createdAt: 'desc' }, take: 20, include: { microcontroller: true } }),
    prisma.fuelSensor.findMany({ orderBy: { lastUpdatedAt: 'desc' }, include: { microcontroller: true } })
  ]);

  const latestGps = new Map();
  for (const log of gpsLogs) if (!latestGps.has(log.microcontrollerId)) latestGps.set(log.microcontrollerId, log);
  const latestFuel = new Map(fuelSensors.map((sensor) => [sensor.microcontrollerId, sensor]));
  const deviceRows = devices.map((device) => {
    const gps = latestGps.get(device.transId);
    const fuel = latestFuel.get(device.transId);
    const mapping = device.busMappings[0];
    return {
      transId: device.transId,
      macAddress: device.macAddress,
      name: device.name,
      model: device.model,
      bus: mapping?.bus?.busNumber ?? null,
      healthStatus: device.healthStatus,
      online: deviceIsOnline(device.lastApiDataReceived),
      lastApiDataReceived: device.lastApiDataReceived,
      lastHealthCheckTime: device.lastHealthCheckTime,
      gps: gps ? { latitude: gps.latitude, longitude: gps.longitude, speed: gps.speed, measuredAt: gps.measuredAt } : null,
      fuel: fuel ? { value: fuel.lastValueMeasured, litres: fuel.lastLitresMeasured, updatedAt: fuel.lastUpdatedAt } : null
    };
  });
  return {
    metrics: {
      activeVehicles: deviceRows.filter((device) => device.online).length,
      totalVehicles: deviceRows.length,
      studentsOnboard: 0,
      averageFuel: fuelSensors.length ? fuelSensors.reduce((sum, sensor) => sum + Number(sensor.lastLitresMeasured ?? 0), 0) / fuelSensors.length : null,
      attendanceToday
    },
    signal: {
      online: deviceRows.filter((device) => device.online).length,
      delayed: deviceRows.filter((device) => device.healthStatus === 'DEGRADED' || (!device.online && device.lastApiDataReceived)).length,
      offline: deviceRows.filter((device) => !device.online).length
    },
    devices: deviceRows,
    recentAttendance: recentAttendance.map((entry) => ({
      transId: entry.transId, scannedAt: entry.scannedAt, cardUid: entry.cardUid, status: entry.attendanceStatus,
      student: entry.student ? `${entry.student.firstName}${entry.student.lastName ? ` ${entry.student.lastName}` : ''}` : 'Unknown card',
      bus: entry.bus?.busNumber ?? 'Unmapped', macAddress: entry.microcontroller.macAddress
    })),
    students
  };
}

app.get('/api/dashboard/overview', async () => ({ success: true, data: await dashboardSnapshot() }));
app.get('/api/dashboard/devices', async (request) => {
  const snapshot = await dashboardSnapshot();
  return { success: true, data: listQuery(snapshot.devices, request.query) };
});
app.get('/api/dashboard/students', async (request) => {
  const records = await prisma.student.findMany({ where: { isActive: true }, orderBy: { createdAt: 'desc' }, take: 500, include: { rfidMappings: { where: { isActive: true } } } });
  return { success: true, data: listQuery(records.map((student) => ({ ...student, rfidMappings: student.rfidMappings.map((mapping) => ({ transId: mapping.transId, cardUid: mapping.cardUid })) })), request.query) };
});
app.get('/api/dashboard/attendance', async (request) => {
  const records = await prisma.studentAttendanceLog.findMany({ orderBy: { scannedAt: 'desc' }, take: 500, include: { student: true, bus: true, microcontroller: true } });
  return { success: true, data: listQuery(records.map((entry) => ({
    transId: entry.transId, scannedAt: entry.scannedAt, cardUid: entry.cardUid, status: entry.attendanceStatus,
    student: entry.student ? `${entry.student.firstName}${entry.student.lastName ? ` ${entry.student.lastName}` : ''}` : 'Unknown card',
    bus: entry.bus?.busNumber ?? 'Unmapped', macAddress: entry.microcontroller.macAddress
  })), request.query) };
});

app.post('/api/admin/microcontrollers', async (request, reply) => {
  const body = request.body ?? {};
  const name = String(body.name ?? '').trim();
  const model = String(body.model ?? '').trim() || null;
  const macAddress = normalizeMac(body.macAddress ?? body.macId);
  if (!name) return reply.code(400).send({ success: false, error: 'name is required' });
  if (!/^[0-9A-F]{12}$/.test(macAddress)) return reply.code(400).send({ success: false, error: 'macAddress must contain 12 hexadecimal characters' });
  const existing = await prisma.microcontroller.findUnique({ where: { macAddress } });
  if (existing) return reply.code(409).send({ success: false, error: 'A device with this MAC address is already registered' });
  const settingsJson = { healthCheckIntervalMinutes: Math.max(1, Number(body.healthCheckIntervalMinutes) || 10), telemetryIntervalMinutes: Math.max(1, Number(body.telemetryIntervalMinutes) || 1), debugHotspotMinutes: 10 };
  const device = await prisma.microcontroller.create({ data: { name, model, macAddress, settingsJson, isFuelEnabled: Boolean(body.isFuelEnabled), isRfidEnabled: Boolean(body.isRfidEnabled), isGpsEnabled: Boolean(body.isGpsEnabled), healthStatus: 'UNKNOWN', createdBy: String(body.createdBy ?? 'admin').trim() || 'admin', fuelSensors: body.isFuelEnabled ? { create: { name: `${name} A22 fuel sensor`, model: String(body.fuelModel ?? 'A22 ultrasonic'), createdBy: 'admin' } } : undefined, gpsSensors: body.isGpsEnabled ? { create: { name: `${name} GPS sensor`, model: String(body.gpsModel ?? 'GPS'), createdBy: 'admin' } } : undefined, rfidSensors: body.isRfidEnabled ? { create: { name: `${name} RFID reader`, model: String(body.rfidModel ?? 'RFID'), createdBy: 'admin' } } : undefined } });
  return reply.code(201).send({ success: true, data: { transId: device.transId, name: device.name, model: device.model, macAddress: device.macAddress, settingsJson: device.settingsJson, isFuelEnabled: device.isFuelEnabled, isRfidEnabled: device.isRfidEnabled, isGpsEnabled: device.isGpsEnabled, isActive: device.isActive } });
});

app.get('/api/admin/buses', async () => ({ success: true, data: await prisma.bus.findMany({ where: { isActive: true }, orderBy: { createdAt: 'desc' }, include: { controllerMappings: { where: { isActive: true }, include: { microcontroller: true } } } }) }));
app.post('/api/admin/buses', async (request, reply) => {
  const body = request.body ?? {};
  const name = String(body.name ?? '').trim(); const busNumber = String(body.busNumber ?? '').trim();
  if (!name || !busNumber) return reply.code(400).send({ success: false, error: 'name and busNumber are required' });
  const bus = await prisma.bus.create({ data: { name, busNumber, registrationNo: String(body.registrationNo ?? '').trim() || null, createdBy: 'admin' } });
  return reply.code(201).send({ success: true, data: bus });
});
app.post('/api/admin/buses/:busId/controllers', async (request, reply) => {
  const busId = String(request.params.busId); const microcontrollerId = String(request.body?.microcontrollerId ?? '');
  if (!microcontrollerId) return reply.code(400).send({ success: false, error: 'microcontrollerId is required' });
  const mapping = await prisma.busControllerMapping.upsert({ where: { busId_microcontrollerId: { busId, microcontrollerId } }, update: { isActive: true, lastUpdatedBy: 'admin' }, create: { busId, microcontrollerId, createdBy: 'admin' } });
  return reply.code(201).send({ success: true, data: mapping });
});
app.post('/api/admin/students', async (request, reply) => {
  const body = request.body ?? {}; const firstName = String(body.firstName ?? '').trim();
  if (!firstName) return reply.code(400).send({ success: false, error: 'firstName is required' });
  const student = await prisma.student.create({ data: { firstName, lastName: String(body.lastName ?? '').trim() || null, admissionNo: String(body.admissionNo ?? '').trim() || null, institution: String(body.institution ?? '').trim() || null, className: String(body.className ?? '').trim() || null, phone: String(body.phone ?? '').trim() || null, createdBy: 'admin' } });
  return reply.code(201).send({ success: true, data: student });
});
app.post('/api/admin/students/:studentId/rfid', async (request, reply) => {
  const studentId = String(request.params.studentId); const cardUid = String(request.body?.cardUid ?? '').replace(/\s/g, '').toUpperCase();
  if (!cardUid) return reply.code(400).send({ success: false, error: 'cardUid is required' });
  const existing = await prisma.studentRfidMapping.findUnique({ where: { cardUid } });
  if (existing && existing.studentId !== studentId) return reply.code(409).send({ success: false, error: 'This RFID card is already mapped to another student' });
  const mapping = existing ? await prisma.studentRfidMapping.update({ where: { transId: existing.transId }, data: { isActive: true, lastUpdatedBy: 'admin' } }) : await prisma.studentRfidMapping.create({ data: { studentId, cardUid, createdBy: 'admin' } });
  return reply.code(201).send({ success: true, data: mapping });
});
app.get('/api/admin/rfid-logs', async () => ({ success: true, data: await prisma.rfidLog.findMany({ orderBy: { scannedAt: 'desc' }, take: 200, include: { microcontroller: true, rfidSensor: true } }) }));
app.get('/api/dashboard/buses', async (request) => {
  const buses = await prisma.bus.findMany({ where: { isActive: true }, orderBy: { createdAt: 'desc' }, include: { controllerMappings: { where: { isActive: true }, include: { microcontroller: true } } } });
  return { success: true, data: listQuery(buses.map((bus) => ({ transId: bus.transId, name: bus.name, busNumber: bus.busNumber, registrationNo: bus.registrationNo, controller: bus.controllerMappings[0]?.microcontroller ? { transId: bus.controllerMappings[0].microcontroller.transId, name: bus.controllerMappings[0].microcontroller.name, macAddress: bus.controllerMappings[0].microcontroller.macAddress, online: deviceIsOnline(bus.controllerMappings[0].microcontroller.lastApiDataReceived) } : null })), request.query) };
});
app.get('/api/dashboard/buses/:busId', async (request, reply) => {
  const bus = await prisma.bus.findUnique({ where: { transId: request.params.busId }, include: { controllerMappings: { where: { isActive: true }, include: { microcontroller: true } } } });
  if (!bus) return reply.code(404).send({ success: false, error: 'Bus not found' });
  const controller = bus.controllerMappings[0]?.microcontroller;
  if (!controller) return { success: true, data: { transId: bus.transId, name: bus.name, busNumber: bus.busNumber, registrationNo: bus.registrationNo, controller: null, gps: [], fuel: null, mappedScans: [], unmappedScanCount: 0 } };
  const [gpsLogs, fuel, mappedScans, unmappedScanCount] = await Promise.all([
    prisma.gpsLog.findMany({ where: { microcontrollerId: controller.transId }, orderBy: { measuredAt: 'desc' }, take: 100 }),
    prisma.fuelSensor.findFirst({ where: { microcontrollerId: controller.transId } }),
    prisma.studentAttendanceLog.findMany({ where: { busId: bus.transId, studentId: { not: null } }, orderBy: { scannedAt: 'desc' }, take: 100, include: { student: true } }),
    prisma.studentAttendanceLog.count({ where: { busId: bus.transId, studentId: null } })
  ]);
  return { success: true, data: { transId: bus.transId, name: bus.name, busNumber: bus.busNumber, registrationNo: bus.registrationNo, controller: { name: controller.name, macAddress: controller.macAddress, online: deviceIsOnline(controller.lastApiDataReceived), lastHealthCheckTime: controller.lastHealthCheckTime }, gps: gpsLogs.map((log) => ({ transId: log.transId, latitude: log.latitude, longitude: log.longitude, speed: log.speed, measuredAt: log.measuredAt })), fuel: fuel ? { litres: fuel.lastLitresMeasured, value: fuel.lastValueMeasured, updatedAt: fuel.lastUpdatedAt } : null, mappedScans: mappedScans.map((scan) => ({ transId: scan.transId, scannedAt: scan.scannedAt, cardUid: scan.cardUid, status: scan.attendanceStatus, student: scan.student ? `${scan.student.firstName}${scan.student.lastName ? ` ${scan.student.lastName}` : ''}` : null })), unmappedScanCount } };
});
app.get('/api/admin/raw-tables', async (request) => {
  const [microcontrollers, fuelSensors, gpsSensors, rfidSensors, microcontrollerLogs, a22Logs, rfidLogs, gpsLogs] = await Promise.all([
    prisma.microcontroller.findMany({ orderBy: { createdAt: 'desc' }, take: 200 }), prisma.fuelSensor.findMany({ orderBy: { createdAt: 'desc' }, take: 200 }), prisma.gps.findMany({ orderBy: { createdAt: 'desc' }, take: 200 }), prisma.rfid.findMany({ orderBy: { createdAt: 'desc' }, take: 200 }), prisma.microcontrollerLog.findMany({ orderBy: { createdAt: 'desc' }, take: 200 }), prisma.a22Log.findMany({ orderBy: { createdAt: 'desc' }, take: 200 }), prisma.rfidLog.findMany({ orderBy: { scannedAt: 'desc' }, take: 200 }), prisma.gpsLog.findMany({ orderBy: { measuredAt: 'desc' }, take: 200 })
  ]);
  const tables = { microcontrollers, fuelSensors, gpsSensors, rfidSensors, microcontrollerLogs, a22Logs, rfidLogs, gpsLogs };
  const table = String(request.query?.table ?? '');
  if (table && tables[table]) return { success: true, data: { table, ...listQuery(tables[table], request.query) } };
  return { success: true, data: tables };
});

app.post('/api/:macId/health', async (request, reply) => {
  const device = await getDevice(request, reply);
  if (!device) return;
  const checkedAt = now();
  const healthData = request.body ?? {};
  await prisma.$transaction([
    prisma.microcontroller.update({
      where: { transId: device.transId },
      data: { lastApiDataReceived: checkedAt, lastHealthCheckTime: checkedAt, healthStatus: 'HEALTHY' }
    }),
    prisma.microcontrollerLog.create({
      data: { microcontrollerId: device.transId, eventType: 'HEALTH_CHECK', status: 'HEALTHY', dataJson: healthData }
    })
  ]);
  return {
    success: true,
    macId: device.macAddress,
    healthStatus: 'HEALTHY',
    settingsJson: device.settingsJson,
    isFuelEnabled: device.isFuelEnabled,
    isRfidEnabled: device.isRfidEnabled,
    isGpsEnabled: device.isGpsEnabled,
    serverTime: checkedAt.toISOString()
  };
});

app.post('/api/:macId/rfid', async (request, reply) => {
  const device = await getDevice(request, reply);
  if (!device) return;
  const body = request.body ?? {};
  const cardUid = String(body.cardUid ?? body.uid ?? '').trim().toUpperCase();
  if (!cardUid) return reply.code(400).send({ success: false, error: 'cardUid is required' });

  const scannedAt = asDate(body.scannedAt);
  const duplicate = await prisma.rfidLog.findFirst({
    where: { microcontrollerId: device.transId, cardUid, scannedAt: { gte: new Date(scannedAt.getTime() - 5000) } },
    orderBy: { scannedAt: 'desc' }
  });
  if (duplicate) return { success: true, duplicate: true, accepted: false, cardUid, serverTime: now().toISOString() };

  const mapping = await prisma.studentRfidMapping.findFirst({ where: { cardUid, isActive: true } });
  const busMapping = await prisma.busControllerMapping.findFirst({
    where: { microcontrollerId: device.transId, isActive: true }, orderBy: { createdAt: 'desc' }
  });
  const sensor = await prisma.rfid.findFirst({ where: { microcontrollerId: device.transId } });
  const dataPacket = body.readerData ?? body.dataPacket ?? body;
  await prisma.$transaction([
    prisma.rfidLog.create({ data: { microcontrollerId: device.transId, rfidSensorId: sensor?.transId, cardUid, dataPacket, scannedAt } }),
    prisma.studentAttendanceLog.create({
      data: {
        studentId: mapping?.studentId,
        microcontrollerId: device.transId,
        busId: busMapping?.busId,
        cardUid,
        attendanceStatus: mapping ? 'SCANNED' : 'UNMAPPED_CARD',
        scannedAt,
        dataJson: dataPacket
      }
    }),
    prisma.microcontroller.update({ where: { transId: device.transId }, data: { lastApiDataReceived: now() } }),
    prisma.microcontrollerLog.create({ data: { microcontrollerId: device.transId, eventType: 'RFID_SCAN', status: 'RECEIVED', dataJson: dataPacket } })
  ]);
  if (sensor) {
    await prisma.rfid.update({
      where: { transId: sensor.transId },
      data: { lastScannedCard: cardUid, lastScannedUuid: cardUid, lastScannedAt: scannedAt, lastDataPacket: dataPacket, healthStatus: 'HEALTHY' }
    });
  }
  return { success: true, accepted: true, mapped: Boolean(mapping), cardUid, serverTime: now().toISOString() };
});

app.post('/api/:macId/telemetry', async (request, reply) => {
  const device = await getDevice(request, reply);
  if (!device) return;
  const body = request.body ?? {};
  const gps = body.gps ?? null;
  const fuel = body.fuel ?? null;
  if (gps === null && fuel === null) return reply.code(400).send({ success: false, error: 'gps or fuel payload is required' });

  const measuredAt = asDate(body.measuredAt);
  const gpsSensor = gps ? await prisma.gps.findFirst({ where: { microcontrollerId: device.transId } }) : null;
  const fuelSensor = fuel ? await prisma.fuelSensor.findFirst({ where: { microcontrollerId: device.transId } }) : null;
  const operations = [];
  if (gps) {
    operations.push(prisma.gpsLog.create({
      data: {
        microcontrollerId: device.transId, gpsId: gpsSensor?.transId,
        latitude: asNumber(gps.latitude), longitude: asNumber(gps.longitude), altitude: asNumber(gps.altitude),
        speed: asNumber(gps.speed), course: asNumber(gps.course), satellites: gps.satellites == null ? null : Number(gps.satellites),
        hdop: asNumber(gps.hdop), nmeaData: gps.nmea ?? gps.nmeaData ?? null, dataJson: gps, measuredAt
      }
    }));
    if (gpsSensor) operations.push(prisma.gps.update({
      where: { transId: gpsSensor.transId },
      data: { lastDataJson: gps, lastLatitude: asNumber(gps.latitude), lastLongitude: asNumber(gps.longitude), lastSpeed: asNumber(gps.speed) }
    }));
  }
  if (fuel) {
    operations.push(prisma.a22Log.create({
      data: {
        microcontrollerId: device.transId, fuelSensorId: fuelSensor?.transId,
        distanceMm: asNumber(fuel.distanceMm ?? fuel.distance), litresMeasured: asNumber(fuel.litresMeasured ?? fuel.litres),
        status: String(fuel.status ?? 'RECEIVED'), dataJson: fuel, measuredAt
      }
    }));
    if (fuelSensor) operations.push(prisma.fuelSensor.update({
      where: { transId: fuelSensor.transId },
      data: { lastDataJson: fuel, lastValueMeasured: asNumber(fuel.distanceMm ?? fuel.distance), lastLitresMeasured: asNumber(fuel.litresMeasured ?? fuel.litres) }
    }));
  }
  operations.push(
    prisma.microcontroller.update({ where: { transId: device.transId }, data: { lastApiDataReceived: now() } }),
    prisma.microcontrollerLog.create({ data: { microcontrollerId: device.transId, eventType: 'TELEMETRY', status: 'RECEIVED', dataJson: body } })
  );
  await prisma.$transaction(operations);
  return { success: true, accepted: true, gpsReceived: gps !== null, fuelReceived: fuel !== null, serverTime: now().toISOString() };
});

app.post('/uploads', async (request, reply) => {
  const file = await request.file();
  if (!file) return reply.code(400).send({ error: 'No file uploaded' });
  return { filename: file.filename, mimetype: file.mimetype, note: 'Storage adapter is ready to be connected.' };
});

app.addHook('onClose', async () => prisma.$disconnect());

const port = Number(process.env.API_PORT || 4000);
await app.listen({ port, host: '0.0.0.0' });
console.log(`HexFleet API listening on port ${port}`);
