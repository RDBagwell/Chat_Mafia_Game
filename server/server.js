import app from './index.js';
import http from 'http';
import { Server } from 'socket.io';
import { initSocket } from './game/socketHandler.js';

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const PORT = process.env.PORT || 3000;

const games = {};

initSocket(io, games);

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
