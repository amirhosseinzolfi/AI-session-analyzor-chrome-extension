/**
 * Generates a beautifully styled PDF from an HTML element and triggers download.
 * Optimized for ChatGPT-style dark/light theme reports.
 */
async function generateSessionPdf(element, filename) {
  const lib = window.html2pdf;
  
  if (!lib) {
    throw new Error("html2pdf library is not loaded. Ensure html2pdf.bundle.min.js is in the extension folder.");
  }

  // Create a clone of the content for PDF styling
  const reportContainer = document.querySelector('.report-container');
  if (!reportContainer) {
    throw new Error("Report container not found");
  }

  // Add PDF mode class for light theme styling
  document.body.classList.add('pdf-mode');

  const options = {
    margin: [12, 12, 12, 12],
    filename: filename,
    image: { 
      type: 'jpeg', 
      quality: 0.98 
    },
    html2canvas: { 
      scale: 2,
      useCORS: true,
      letterRendering: true,
      logging: false,
      backgroundColor: '#ffffff',
      scrollY: 0,
      windowWidth: 900,
      onclone: (clonedDoc) => {
        // Apply PDF-specific styles to the cloned document
        const body = clonedDoc.body;
        body.style.background = '#ffffff';
        body.style.color = '#1f2937';
        
        // Style the report container
        const container = clonedDoc.querySelector('.report-container');
        if (container) {
          container.style.background = '#ffffff';
          container.style.border = 'none';
          container.style.boxShadow = 'none';
        }
        
        // Style report header
        const header = clonedDoc.querySelector('.report-header');
        if (header) {
          header.style.background = 'linear-gradient(135deg, #10a37f 0%, #1ed9a4 100%)';
          header.style.color = 'white';
        }
        
        // Style title
        const title = clonedDoc.querySelector('.report-title');
        if (title) {
          title.style.color = 'white';
        }
        
        // Style meta items
        const metaItems = clonedDoc.querySelectorAll('.meta-item');
        metaItems.forEach(item => {
          item.style.color = 'rgba(255, 255, 255, 0.9)';
        });
        
        // Style content
        const content = clonedDoc.querySelector('.report-content');
        if (content) {
          content.style.background = '#ffffff';
          content.style.padding = '32px';
        }
        
        // Style report content text
        const reportContent = clonedDoc.querySelector('#reportContent');
        if (reportContent) {
          reportContent.style.color = '#374151';
        }
        
        // Style h2 elements
        const h2s = clonedDoc.querySelectorAll('#reportContent h2');
        h2s.forEach(h2 => {
          h2.style.background = '#ecfdf5';
          h2.style.color = '#047857';
          h2.style.borderRightColor = '#10a37f';
          h2.style.padding = '12px 20px';
          h2.style.borderRadius = '8px';
          h2.style.marginTop = '24px';
          h2.style.marginBottom = '16px';
        });
        
        // Style h3 elements
        const h3s = clonedDoc.querySelectorAll('#reportContent h3');
        h3s.forEach(h3 => {
          h3.style.background = '#f5f3ff';
          h3.style.color = '#6d28d9';
          h3.style.borderRightColor = '#8b5cf6';
          h3.style.padding = '10px 16px';
          h3.style.borderRadius = '6px';
          h3.style.marginTop = '20px';
          h3.style.marginBottom = '12px';
        });
        
        // Style paragraphs
        const paragraphs = clonedDoc.querySelectorAll('#reportContent p');
        paragraphs.forEach(p => {
          p.style.color = '#4b5563';
          p.style.marginBottom = '12px';
          p.style.lineHeight = '1.8';
        });
        
        // Style list items
        const lis = clonedDoc.querySelectorAll('#reportContent li');
        lis.forEach(li => {
          li.style.color = '#4b5563';
          li.style.marginBottom = '8px';
        });
        
        // Style blockquotes
        const blockquotes = clonedDoc.querySelectorAll('#reportContent blockquote');
        blockquotes.forEach(bq => {
          bq.style.background = '#f0fdf4';
          bq.style.borderRightColor = '#10a37f';
          bq.style.padding = '16px 20px';
          bq.style.borderRadius = '8px';
        });
        
        // Style code blocks
        const pres = clonedDoc.querySelectorAll('#reportContent pre');
        pres.forEach(pre => {
          pre.style.background = '#1e293b';
          pre.style.padding = '16px';
          pre.style.borderRadius = '8px';
          pre.style.marginBottom = '16px';
        });
        
        // Hide header bar in PDF
        const headerBar = clonedDoc.querySelector('.header-bar');
        if (headerBar) {
          headerBar.style.display = 'none';
        }
        
        // Hide toast
        const toast = clonedDoc.querySelector('#toast');
        if (toast) {
          toast.style.display = 'none';
        }
        
        // Adjust page wrapper
        const pageWrapper = clonedDoc.querySelector('.page-wrapper');
        if (pageWrapper) {
          pageWrapper.style.minHeight = 'auto';
        }
        
        // Adjust content area
        const contentArea = clonedDoc.querySelector('.content-area');
        if (contentArea) {
          contentArea.style.padding = '0';
          contentArea.style.maxWidth = '100%';
        }
      }
    },
    jsPDF: { 
      unit: 'mm', 
      format: 'a4', 
      orientation: 'portrait',
      compress: true
    },
    pagebreak: { 
      mode: ['avoid-all', 'css', 'legacy'],
      before: '.page-break-before',
      after: '.page-break-after',
      avoid: ['h2', 'h3', 'h4', 'blockquote', 'pre', '.summary-box']
    }
  };

  try {
    await lib().set(options).from(reportContainer).save();
  } finally {
    // Remove PDF mode class
    document.body.classList.remove('pdf-mode');
  }
}
