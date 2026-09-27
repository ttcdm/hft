use std::sync::atomic::{AtomicUsize, Ordering};

pub const BUFFER_CAPACITY: usize = 4096;

#[repr(align(64))]
pub struct LockFreeRingBuffer<T: Copy + Default> {
    buffer: Box<[T; BUFFER_CAPACITY]>,
    head: AtomicUsize,
    tail: AtomicUsize,
}

impl<T: Copy + Default> Default for LockFreeRingBuffer<T> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T: Copy + Default> LockFreeRingBuffer<T> {
    pub fn new() -> Self {
        Self {
            buffer: Box::new([T::default(); BUFFER_CAPACITY]),
            head: AtomicUsize::new(0),
            tail: AtomicUsize::new(0),
        }
    }

    #[inline(always)]
    pub fn try_push(&self, item: T) -> bool {
        let head = self.head.load(Ordering::Relaxed);
        let tail = self.tail.load(Ordering::Acquire);

        if head.wrapping_sub(tail) >= BUFFER_CAPACITY {
            return false; // Buffer full
        }

        let idx = head & (BUFFER_CAPACITY - 1);
        unsafe {
            let ptr = self.buffer.as_ptr() as *mut T;
            ptr.add(idx).write(item);
        }

        self.head.store(head.wrapping_add(1), Ordering::Release);
        true
    }

    #[inline(always)]
    pub fn try_pop(&self) -> Option<T> {
        let tail = self.tail.load(Ordering::Relaxed);
        let head = self.head.load(Ordering::Acquire);

        if tail == head {
            return None; // Buffer empty
        }

        let idx = tail & (BUFFER_CAPACITY - 1);
        let item = unsafe {
            let ptr = self.buffer.as_ptr();
            *ptr.add(idx)
        };

        self.tail.store(tail.wrapping_add(1), Ordering::Release);
        Some(item)
    }

    pub fn is_empty(&self) -> bool {
        self.head.load(Ordering::Relaxed) == self.tail.load(Ordering::Relaxed)
    }

    pub fn len(&self) -> usize {
        let head = self.head.load(Ordering::Relaxed);
        let tail = self.tail.load(Ordering::Relaxed);
        head.wrapping_sub(tail)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ring_buffer_push_pop() {
        let rb = LockFreeRingBuffer::<u64>::new();
        assert!(rb.is_empty());
        assert_eq!(rb.len(), 0);

        assert!(rb.try_push(42));
        assert!(rb.try_push(100));
        assert_eq!(rb.len(), 2);
        assert!(!rb.is_empty());

        assert_eq!(rb.try_pop(), Some(42));
        assert_eq!(rb.try_pop(), Some(100));
        assert_eq!(rb.try_pop(), None);
        assert!(rb.is_empty());
    }

    #[test]
    fn test_ring_buffer_full() {
        let rb = LockFreeRingBuffer::<u32>::new();
        for i in 0..BUFFER_CAPACITY {
            assert!(rb.try_push(i as u32));
        }
        assert_eq!(rb.len(), BUFFER_CAPACITY);
        assert!(!rb.try_push(9999)); // Should be full
        assert_eq!(rb.try_pop(), Some(0));
        assert!(rb.try_push(9999)); // Now has room
    }
}
