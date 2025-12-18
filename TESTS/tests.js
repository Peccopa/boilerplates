const str = 'L5A0B1';

function correct(string) {
  return string.replace(/[015]/g, (i) => ['O', 'I', , , , 'S'][i]);
}

console.log(correct(str));
