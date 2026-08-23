const fs = require('fs');
const { SourceMapConsumer } = require('source-map');
const rawSourceMap = JSON.parse(fs.readFileSync('index.android.bundle.map', 'utf8'));

SourceMapConsumer.with(rawSourceMap, null, consumer => {
  const pos1 = consumer.originalPositionFor({
    line: 1,
    column: 606183
  });
  console.log('useFaceProcessor:', pos1.source, pos1.line, pos1.name);

  const pos2 = consumer.originalPositionFor({
    line: 1,
    column: 585609
  });
  console.log('EnrollFaceScreen:', pos2.source, pos2.line, pos2.name);
});
