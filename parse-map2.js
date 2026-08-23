const fs = require('fs');
const { SourceMapConsumer } = require('source-map');
const rawSourceMap = JSON.parse(fs.readFileSync('index.android.bundle.map', 'utf8'));

async function run() {
  const consumer = await new SourceMapConsumer(rawSourceMap);
  const pos1 = consumer.originalPositionFor({
    line: 1,
    column: 606183
  });
  console.log('useFaceProcessor:', pos1);

  const pos2 = consumer.originalPositionFor({
    line: 1,
    column: 585609
  });
  console.log('EnrollFaceScreen:', pos2);
  consumer.destroy();
}
run().catch(console.error);
