(function () {
  this.b = 'b'
  try {
    const a = 1;
  } catch {
    const b = 2;
  }
}).call(this)
