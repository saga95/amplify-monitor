// Amplify Monitor Documentation - Main JavaScript

document.addEventListener('DOMContentLoaded', function() {
    // Mobile menu toggle
    const mobileMenuBtn = document.querySelector('.mobile-menu-btn');
    const navLinks = document.querySelector('.nav-links');
    
    if (mobileMenuBtn && navLinks) {
        mobileMenuBtn.addEventListener('click', function() {
            navLinks.classList.toggle('mobile-open');
            const icon = mobileMenuBtn.querySelector('i');
            if (icon) {
                icon.classList.toggle('fa-bars');
                icon.classList.toggle('fa-times');
            }
        });
    }

    // Smooth scrolling for anchor links
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function(e) {
            e.preventDefault();
            const target = document.querySelector(this.getAttribute('href'));
            if (target) {
                target.scrollIntoView({
                    behavior: 'smooth',
                    block: 'start'
                });
            }
        });
    });

    // Navbar background on scroll
    const navbar = document.querySelector('.navbar');
    if (navbar) {
        window.addEventListener('scroll', function() {
            if (window.scrollY > 50) {
                navbar.classList.add('scrolled');
            } else {
                navbar.classList.remove('scrolled');
            }
        });
    }

    // Active nav link highlighting for documentation pages
    const docNavLinks = document.querySelectorAll('.doc-nav a');
    const currentPath = window.location.pathname;
    
    docNavLinks.forEach(link => {
        if (link.getAttribute('href') === currentPath || 
            link.getAttribute('href') === currentPath.split('/').pop()) {
            link.classList.add('active');
        }
    });

    // Copy code blocks
    document.querySelectorAll('pre code').forEach(block => {
        const pre = block.parentElement;
        const copyBtn = document.createElement('button');
        copyBtn.className = 'copy-code-btn';
        copyBtn.innerHTML = '<i class="fas fa-copy"></i>';
        copyBtn.title = 'Copy to clipboard';
        
        copyBtn.addEventListener('click', async function() {
            try {
                await navigator.clipboard.writeText(block.textContent);
                copyBtn.innerHTML = '<i class="fas fa-check"></i>';
                copyBtn.classList.add('copied');
                setTimeout(() => {
                    copyBtn.innerHTML = '<i class="fas fa-copy"></i>';
                    copyBtn.classList.remove('copied');
                }, 2000);
            } catch (err) {
                console.error('Failed to copy:', err);
            }
        });
        
        pre.style.position = 'relative';
        pre.appendChild(copyBtn);
    });

    // Table of contents generation for documentation pages
    const docContent = document.querySelector('.doc-content');
    const tocContainer = document.querySelector('.toc-container');
    
    if (docContent && tocContainer) {
        const headings = docContent.querySelectorAll('h2, h3');
        const toc = document.createElement('ul');
        toc.className = 'toc-list';
        
        headings.forEach((heading, index) => {
            const id = heading.id || `heading-${index}`;
            heading.id = id;
            
            const li = document.createElement('li');
            li.className = heading.tagName === 'H3' ? 'toc-item-sub' : 'toc-item';
            
            const a = document.createElement('a');
            a.href = `#${id}`;
            a.textContent = heading.textContent;
            
            li.appendChild(a);
            toc.appendChild(li);
        });
        
        tocContainer.appendChild(toc);
    }

    // Intersection Observer for animations
    const observerOptions = {
        root: null,
        rootMargin: '0px',
        threshold: 0.1
    };

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('animate-in');
            }
        });
    }, observerOptions);

    document.querySelectorAll('.feature-card, .step, .testimonial').forEach(el => {
        el.classList.add('animate-ready');
        observer.observe(el);
    });

    // Search functionality (for future implementation)
    const searchInput = document.querySelector('.search-input');
    if (searchInput) {
        searchInput.addEventListener('input', function(e) {
            const query = e.target.value.toLowerCase();
            // Implement search logic here
            console.log('Search query:', query);
        });
    }

    // Version selector (for future implementation)
    const versionSelect = document.querySelector('.version-select');
    if (versionSelect) {
        versionSelect.addEventListener('change', function(e) {
            const version = e.target.value;
            console.log('Selected version:', version);
            // Redirect to version-specific docs
        });
    }
});

// Add CSS for copy button dynamically
const style = document.createElement('style');
style.textContent = `
    .copy-code-btn {
        position: absolute;
        top: 8px;
        right: 8px;
        background: var(--bg-card);
        border: 1px solid var(--border);
        color: var(--text-muted);
        padding: 6px 10px;
        border-radius: 4px;
        cursor: pointer;
        opacity: 0;
        transition: all 0.2s ease;
    }
    
    pre:hover .copy-code-btn {
        opacity: 1;
    }
    
    .copy-code-btn:hover {
        background: var(--border);
        color: var(--text-bright);
    }
    
    .copy-code-btn.copied {
        color: var(--success);
    }
    
    .animate-ready {
        opacity: 0;
        transform: translateY(20px);
        transition: opacity 0.5s ease, transform 0.5s ease;
    }
    
    .animate-in {
        opacity: 1;
        transform: translateY(0);
    }
    
    .nav-links.mobile-open {
        display: flex !important;
        flex-direction: column;
        position: absolute;
        top: 100%;
        left: 0;
        right: 0;
        background: var(--bg-secondary);
        padding: 24px;
        border-bottom: 1px solid var(--border);
    }
    
    .toc-list {
        list-style: none;
        padding: 0;
    }
    
    .toc-item {
        margin-bottom: 8px;
    }
    
    .toc-item-sub {
        margin-left: 16px;
        margin-bottom: 6px;
        font-size: 0.9em;
    }
    
    .navbar.scrolled {
        box-shadow: var(--shadow-sm);
    }
`;
document.head.appendChild(style);
