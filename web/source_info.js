export function createSourceInfo() {
    const element = document.createElement('div');
    element.className = 'media-ab-sources';
    element.hidden = true;
    const sides = ['A', 'B'].map(letter => {
        const item = document.createElement('div');
        const side = document.createElement('b');
        const size = document.createElement('span');
        const name = document.createElement('span');
        side.textContent = letter;
        name.className = 'media-ab-filename';
        item.hidden = true;
        item.append(side, size, name);
        element.append(item);
        return {item, size, name};
    });
    function update(index, width, height, filename, extra = '') {
        const {item, size, name} = sides[index];
        item.hidden = !(width > 0 && height > 0);
        size.textContent = item.hidden ? '' : `${width}×${height}`;
        name.textContent = filename || '';
        item.title = [filename, size.textContent, extra].filter(Boolean).join(' · ');
        element.hidden = sides.every(side => side.item.hidden);
    }
    return {element, update};
}
