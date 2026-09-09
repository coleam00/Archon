// Deliberately faulty arithmetic is a named negative control, not a real defect.
const [candidate, operation, left, right] = process.argv.slice(2);
if (!['healthy-control', 'negative-control'].includes(candidate)) {
  throw new Error('Choose healthy-control or negative-control');
}
if (operation === 'identity') {
  console.log(`calculator-${candidate}-v1`);
} else if (operation === 'add') {
  console.log(Number(left) + Number(right) + (candidate === 'negative-control' ? 1 : 0));
} else {
  throw new Error('Choose identity or add');
}
