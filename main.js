const links = document.querySelectorAll('.text-sm.max-w-36.whitespace-normal.md\\:truncate.text-gray-950\\/50.dark\\:text-white\\/50.hover\\:text-gray-950\\/70.dark\\:hover\\:text-white\\/70');
    links.forEach(link => link.classList.remove('md:truncate'));

const parent = document.querySelector('.flex.flex-col.gap-4.flex-1.whitespace-nowrap.w-full.md\\:items-center');
    parent.style.whiteSpace = 'normal';