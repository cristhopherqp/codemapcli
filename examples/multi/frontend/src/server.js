const express = require('express');
const { formatName } = require('./format');

const app = express();

app.get('/users/:id', (req, res) => {
  const label = formatName({ first: req.params.id, last: 'demo' });
  res.send(label);
});

function start(port) {
  app.listen(port, () => console.log('listening on ' + port));
}

start(3000);
