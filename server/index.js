import express from 'express';
const app = express();

app.use(express.json());

app.use(express.static(new URL('../client', import.meta.url).pathname));

app.get('/', (req, res) => {
  res.send('Mafia Server Running');
});

export default app;