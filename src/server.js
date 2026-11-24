import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });
await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });

app.get('/health', async () => ({ status: 'ok', service: 'hexfleet-api', timestamp: new Date().toISOString() }));
app.post('/uploads', async (request, reply) => {
  const file = await request.file();
  if (!file) return reply.code(400).send({ error: 'No file uploaded' });
  return { filename: file.filename, mimetype: file.mimetype, note: 'Storage adapter is ready to be connected.' };
});

const port = Number(process.env.API_PORT || 4000);
await app.listen({ port, host: '0.0.0.0' });
